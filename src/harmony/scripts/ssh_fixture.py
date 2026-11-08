#!/usr/bin/env python3
"""Ephemeral loopback SSH protocol fixture. Never reads user accounts or real keys."""
import argparse
import io
import socket
import subprocess
import threading
import time
import logging
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import paramiko
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

logging.getLogger('paramiko').setLevel(logging.CRITICAL)

def key():
    private = Ed25519PrivateKey.generate().private_bytes(serialization.Encoding.PEM,
        serialization.PrivateFormat.OpenSSH, serialization.NoEncryption()).decode()
    return private, paramiko.Ed25519Key.from_private_key(io.StringIO(private))

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--probe',required=True); parser.add_argument('--hdc'); parser.add_argument('--target', default='127.0.0.1:15566'); args=parser.parse_args()
    host_text,host_key=key(); private,user_key=key()
    public=host_key.get_name()+' '+host_key.get_base64()
    wrong=user_key.get_name()+' '+user_key.get_base64()
    counter={'authenticated':0,'commands':0,'resizes':[]}; lock=threading.Lock()
    class Server(paramiko.ServerInterface):
        def check_auth_publickey(self,username,key):
            with lock: counter['authenticated']+=1
            return paramiko.AUTH_SUCCESSFUL if username=='fixture' and key==user_key else paramiko.AUTH_FAILED
        def check_auth_password(self,username,password):
            with lock: counter['authenticated']+=1
            return paramiko.AUTH_SUCCESSFUL if username=='fixture' and password=='fixture-password' else paramiko.AUTH_FAILED
        def get_allowed_auths(self,username): return 'publickey,password'
        def check_channel_request(self,kind,channel): return paramiko.OPEN_SUCCEEDED if kind=='session' else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED
        def check_channel_pty_request(self,*_): return True
        def check_channel_shell_request(self,*_): return True
        def check_channel_window_change_request(self,channel,width,height,*_):
            with lock: counter['resizes'].append((width,height))
            return True
    listener=socket.socket(); listener.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);listener.bind(('127.0.0.1',18741));listener.listen()
    def handle(connection):
        transport=paramiko.Transport(connection);transport.add_server_key(host_key)
        try:
            transport.start_server(server=Server());channel=transport.accept(10)
            if channel is None:return
            channel.settimeout(10)
            data=b''
            while not data.endswith(b'\n') and len(data)<4096:
                part=channel.recv(4096-len(data))
                if not part:break
                data+=part
            if data in (b'fixture-command\n', b'fixture-retention\n'):
                with lock: counter['commands']+=1
                channel.sendall('SSH_FIXTURE_OK 布布\r\n'.encode());channel.send_exit_status(23 if data==b'fixture-retention\n' else 0);time.sleep(.15)
            channel.close()
        except Exception: pass
        finally: transport.close()
    def accept():
        while True:
            try: connection,_=listener.accept()
            except OSError:return
            threading.Thread(target=handle,args=(connection,),daemon=True).start()
    threading.Thread(target=accept,daemon=True).start()
    stall=socket.socket();stall.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);stall.bind(('127.0.0.1',18742));stall.listen()
    def stalled():
        try: connection,_=stall.accept()
        except OSError:return
        try: time.sleep(5)
        finally: connection.close()
    threading.Thread(target=stalled,daemon=True).start()
    class CredentialFixture(BaseHTTPRequestHandler):
        def log_message(self,*_):pass
        def do_GET(self):
            content=(private if self.path=='/key' else 'fixture-password\n').encode()
            self.send_response(200);self.send_header('Content-Length',str(len(content)));self.end_headers();self.wfile.write(content)
    credential_server=ThreadingHTTPServer(('127.0.0.1',18743),CredentialFixture)
    threading.Thread(target=credential_server.serve_forever,daemon=True).start()
    hdc=[args.hdc,'-t',args.target] if args.hdc else []
    try:
        if hdc:
            for port in [18741,18742,18743]:subprocess.run(hdc+['rport','tcp:'+str(port),'tcp:'+str(port)],check=True,capture_output=True)
        for mode,pin,port in [('key',public,18741),('password',public,18741),('retention',public,18741),('mismatch',wrong,18741),('cancel',public,18742)]:
            before=counter['authenticated']; command=hdc+['shell',args.probe,'127.0.0.1',str(port),pin,mode] if hdc else [args.probe,'127.0.0.1',str(port),pin,mode]
            # hdc shell performs remote shell parsing, so quote the public host key argument explicitly.
            if hdc: command=hdc+['shell',args.probe+' 127.0.0.1 '+str(port)+' '+"'"+pin+"'"+' '+mode]
            payload=(private if mode=='key' else 'fixture-password\n')+'LEO_FIXTURE_END\n'
            if hdc:
                command[-1]+=' 18743'
                result=subprocess.run(command,text=True,capture_output=True,timeout=25)
            else:
                result=subprocess.run(command,input=payload,text=True,capture_output=True,timeout=25)
            if result.returncode or 'SSH_PROBE_OK '+mode not in result.stdout:
                # Output can contain stdin echo on a test PTY; never print it.
                raise RuntimeError('SSH fixture case failed: '+mode+' exit='+str(result.returncode)+' output='+result.stdout[-1000:])
            if mode=='mismatch' and counter['authenticated']!=before:raise RuntimeError('host key mismatch reached authentication')
            print('SSH_FIXTURE_PASS '+mode,flush=True)
        assert counter['commands']==3,counter['commands']
        assert counter['resizes'].count((120,40))==3, counter['resizes']
        print('SSH_FIXTURE_ALL_PASS real Ed25519 key/password auth, host pin rejection before auth, owner isolation, PTY, final-frame retention across owners and cancellation',flush=True)
    finally:
        listener.close();stall.close();credential_server.shutdown();credential_server.server_close()
        if hdc:
            for port in [18741,18742,18743]:subprocess.run(hdc+['rport','rm','tcp:'+str(port),'tcp:'+str(port)],capture_output=True)

if __name__=='__main__':main()
