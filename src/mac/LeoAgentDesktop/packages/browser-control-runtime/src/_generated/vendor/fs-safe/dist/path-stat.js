export function pathStatFromStats(stat) {
    return {
        dev: Number(stat.dev),
        gid: Number(stat.gid),
        ino: Number(stat.ino),
        isDirectory: stat.isDirectory(),
        isFile: stat.isFile(),
        isSymbolicLink: stat.isSymbolicLink(),
        mode: stat.mode,
        mtimeMs: stat.mtimeMs,
        nlink: stat.nlink,
        size: stat.size,
        uid: stat.uid,
    };
}
