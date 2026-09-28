#!/usr/bin/env python3
"""Run the production Swift tailnet transport against a real loopback HTTP fixture."""
import hashlib, json, subprocess, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

state = {'scenario': 'history', 'upload': b'abc'}
replicas = {'history':'11111111-1111-4111-8111-111111111111','reset':'22222222-2222-4222-8222-222222222222',
            'backwards':'22222222-2222-4222-8222-222222222222','full':'33333333-3333-4333-8333-333333333333',
            'asset':'44444444-4444-4444-8444-444444444444'}
asset_bytes = b'abcdef'
asset_hash = hashlib.sha256(asset_bytes).hexdigest()
def change(name, cursor, operation='upsert', asset=False):
    identity = {'type':'MessageV2','id':name}
    row = {'changeId':str(cursor),'revision':cursor,'id':identity,'operation':operation,'updatedAt':float(cursor)}
    if operation == 'upsert':
        assets = {'body':{'key':'body','sha256':asset_hash,'size':6}} if asset else {}
        row['record'] = {'id':identity,'fields':{},'assets':assets,'schemaVersion':1,'unknownFields':{},'updatedAt':float(cursor)}
    return {'cursor':cursor,'senderDeviceId':'source','change':row}
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def reply(self,status,body=None,headers=None):
        data = json.dumps(body).encode() if body is not None else b''
        self.send_response(status)
        for key,value in (headers or {}).items(): self.send_header(key,str(value))
        self.send_header('Content-Length',str(len(data))); self.end_headers()
        if self.command != 'HEAD': self.wfile.write(data)
    def do_POST(self):
        path = urlparse(self.path).path
        raw = self.rfile.read(int(self.headers.get('Content-Length','0')))
        if path.startswith('/test/'):
            state['scenario'] = path.split('/')[-1]; self.reply(200,{}); return
        if path == '/sync/v1/changes':
            assert state['upload'] == asset_bytes
            row = json.loads(raw)['changes'][0]
            self.reply(200,{'replicaId':replicas[state['scenario']], 'receipts':[{'changeId':row['changeId'],'revision':row['revision'],'status':'stored','cursor':2}]}); return
        self.reply(404)
    def do_GET(self):
        url = urlparse(self.path)
        if url.path.startswith('/sync/v1/assets/'):
            start,end = map(int,self.headers['Range'][6:].split('-'))
            chunk = asset_bytes[start:end+1]
            self.send_response(206); self.send_header('Content-Length',str(len(chunk)))
            self.send_header('Content-Range',f'bytes {start}-{end}/6'); self.send_header('ETag',f'"{asset_hash}"')
            self.end_headers(); self.wfile.write(chunk); return
        after = int(parse_qs(url.query).get('after',['0'])[0]); mode=state['scenario']
        if mode == 'reset' and after>1: self.reply(409,{}); return
        rows=[]; more=False; cursor=after
        if mode=='history' and after==0: rows=[change('same',1,'delete'),change('same',2)]; cursor=2
        elif mode=='reset' and after==0: rows=[change('reset',1)]; cursor=1
        elif mode=='backwards': cursor=0
        elif mode=='full' and after==0: rows=[change('first',1)]; cursor=1; more=True
        elif mode=='full' and after==1: rows=[change('second',2)]; cursor=2
        elif mode=='asset' and after==0: rows=[change('asset',1,asset=True)]; cursor=1
        self.reply(200,{'replicaId':replicas[mode],'changes':rows,'nextCursor':cursor,'hasMore':more})
    def do_HEAD(self):
        self.reply(200,headers={'Upload-Length':6,'Upload-Offset':len(state['upload']),'X-Asset-Complete':str(state['upload']==asset_bytes).lower()})
    def do_PUT(self):
        chunk=self.rfile.read(int(self.headers['Content-Length']))
        assert self.headers['Content-Range']=='bytes 3-5/6', self.headers['Content-Range']
        state['upload'] += chunk
        self.reply(200,{'size':6,'offset':len(state['upload']),'complete':state['upload']==asset_bytes})
server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
try:
    result=subprocess.run([sys.argv[1] if len(sys.argv)>1 else '/tmp/leo-tailnet-io-smoke',f'http://127.0.0.1:{server.server_port}'])
    raise SystemExit(result.returncode)
finally: server.shutdown(); server.server_close()
