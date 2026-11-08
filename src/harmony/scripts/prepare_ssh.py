#!/usr/bin/env python3
"""Build pinned, patched libssh2 and minimal static OpenSSL Crypto for the OHOS ABI."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

HERE = Path(__file__).resolve().parent
NATIVE = Path(os.environ.get('DEVECO_SDK_HOME', '/Applications/DevEco-Studio.app/Contents/sdk')) / 'default/openharmony/native'
if not NATIVE.exists():
    NATIVE = Path('/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/native')
OUTPUT = HERE.parent / 'app/entry/src/main/cpp/ssh/generated'
CACHE = Path.home() / 'Library/Caches/leobot-harmony-ssh'
MANIFEST = json.loads((HERE / 'ssh-dependencies.json').read_text())
JOBS = str(min(8, os.cpu_count() or 4))
CMAKE = NATIVE / 'build-tools/cmake/bin/cmake'


def run(argv, cwd=None, env=None):
    if argv[0] == 'cmake':
        argv = [CMAKE] + argv[1:]
    print('+', ' '.join(str(value) for value in argv), flush=True)
    subprocess.run([str(value) for value in argv], cwd=cwd, env=env, check=True)


def checksum(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source(name, metadata):
    archive = CACHE / (name + '.tar.gz')
    if not archive.exists() or checksum(archive) != metadata['sha256']:
        temporary = archive.with_suffix('.download')
        run(['curl', '-fL', '--max-time', '180', '--retry', '1', metadata['url'], '-o', temporary])
        if checksum(temporary) != metadata['sha256']:
            raise RuntimeError(name + ' source checksum mismatch')
        temporary.replace(archive)
    directory = CACHE / ('source-' + name)
    if directory.exists():
        shutil.rmtree(directory)
    directory.mkdir()
    with tarfile.open(archive) as package:
        package.extractall(directory, filter='data')
    return next(directory.iterdir())


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    compiler_version = subprocess.check_output([str(NATIVE / 'llvm/bin/clang'), '--version'], text=True)
    identity = hashlib.sha256((json.dumps(MANIFEST, sort_keys=True) + Path(__file__).read_text() + str(NATIVE) + compiler_version).encode()).hexdigest()
    marker = OUTPUT / 'build.json'
    if marker.exists() and json.loads(marker.read_text()).get('identity') == identity:
        cached = json.loads(marker.read_text())
        if all((OUTPUT / 'lib' / filename).exists() and checksum(OUTPUT / 'lib' / filename) == cached.get('libraries', {}).get(filename) for filename in ['libcrypto.a', 'libssh2.a']):
            print('SSH_DEPENDENCIES_CACHED', flush=True)
            return
    crypto_library = CACHE / 'install-arm64/lib/libcrypto.a'
    crypto_marker = CACHE / 'install-arm64/crypto-build.json'
    crypto_identity = hashlib.sha256((json.dumps(MANIFEST['openssl'], sort_keys=True) + compiler_version + str(NATIVE) + 'OHOS-arm64-PIC-no-async-no-engine-no-dso-no-module-no-legacy').encode()).hexdigest()
    crypto_receipt = json.loads(crypto_marker.read_text()) if crypto_marker.exists() else {}
    crypto_ready = crypto_library.exists() and crypto_receipt.get('identity') == crypto_identity and crypto_receipt.get('sha256') == checksum(crypto_library)
    openssl_root = CACHE / ('source-openssl-' + MANIFEST['openssl']['version'])
    openssl = next(openssl_root.iterdir()) if crypto_ready and openssl_root.exists() else source('openssl-' + MANIFEST['openssl']['version'], MANIFEST['openssl'])
    install = CACHE / 'install-arm64'
    (install / 'lib').mkdir(parents=True, exist_ok=True)
    compiler = NATIVE / 'llvm/bin'
    env = os.environ.copy()
    env.update({'CC': str(compiler / 'clang'), 'AR': str(compiler / 'llvm-ar'), 'RANLIB': str(compiler / 'llvm-ranlib'),
                'CFLAGS': '--target=aarch64-linux-ohos --sysroot=' + str(NATIVE / 'sysroot') + ' -fPIC'})
    if not crypto_ready:
        run(['perl', './Configure', 'linux-aarch64', 'no-shared', 'no-tests', 'no-async', 'no-engine', 'no-dso', 'no-module',
             'no-legacy', '--prefix=' + str(install), '--openssldir=' + str(install / 'ssl')], openssl, env)
        run(['make', '-j' + JOBS, 'build_generated', 'libcrypto.a'], openssl, env)
        shutil.copy2(openssl / 'libcrypto.a', install / 'lib/libcrypto.a')
        shutil.copytree(openssl / 'include/openssl', install / 'include/openssl', dirs_exist_ok=True)
        crypto_marker.write_text(json.dumps({'identity': crypto_identity, 'sha256': checksum(crypto_library)}))
    ssh = source('libssh2-' + MANIFEST['libssh2']['version'], MANIFEST['libssh2'])
    for patch in MANIFEST['patches']:
        path = HERE / 'ssh-patches' / patch['file']
        if checksum(path) != patch['sha256']:
            raise RuntimeError('SSH security patch checksum mismatch')
        run(['patch', '-p1', '--batch', '--forward', '-i', path], ssh)
    build = CACHE / 'build-ssh2-arm64'
    if build.exists():
        shutil.rmtree(build)
    run(['cmake', '-S', ssh, '-B', build, '-G', 'Ninja',
         '-DCMAKE_MAKE_PROGRAM=' + str(NATIVE / 'build-tools/cmake/bin/ninja'),
         '-DCMAKE_TOOLCHAIN_FILE=' + str(NATIVE / 'build/cmake/ohos.toolchain.cmake'),
         '-DOHOS_ARCH=arm64-v8a', '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_POSITION_INDEPENDENT_CODE=ON',
         '-DBUILD_SHARED_LIBS=OFF', '-DBUILD_EXAMPLES=OFF', '-DBUILD_TESTING=OFF', '-DENABLE_ZLIB_COMPRESSION=OFF',
         '-DCRYPTO_BACKEND=OpenSSL', '-DOPENSSL_USE_STATIC_LIBS=ON', '-DOPENSSL_CRYPTO_LIBRARY=' + str(install / 'lib/libcrypto.a'),
         '-DOPENSSL_INCLUDE_DIR=' + str(install / 'include'), '-DCMAKE_INSTALL_PREFIX=' + str(install)])
    run(['cmake', '--build', build, '-j', JOBS])
    run(['cmake', '--install', build])
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for directory in ['include', 'lib']:
        destination = OUTPUT / directory
        if destination.exists():
            shutil.rmtree(destination)
        shutil.copytree(install / directory, destination)
    licenses = 'libssh2 1.11.1 with security backports\n' + (ssh / 'COPYING').read_text() + '\nOpenSSL 3.5.9\n' + (openssl / 'LICENSE.txt').read_text()
    (HERE.parent / 'app/entry/src/main/resources/rawfile/ssh-licenses.txt').write_text(licenses)
    marker.write_text(json.dumps({'identity': identity, 'sources': MANIFEST,
                                  'libraries': {path.name: checksum(path) for path in (OUTPUT / 'lib').glob('*.a')}}, indent=2) + '\n')
    print('SSH_DEPENDENCIES_OK ' + identity, flush=True)


if __name__ == '__main__':
    main()
