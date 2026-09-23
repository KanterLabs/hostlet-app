#!/usr/bin/env python3
"""TLS loopback gateway for exact coordinated release manifests."""
import argparse
import hashlib
import http.client
import http.cookies
import http.server
import json
import mimetypes
import os
import re
import socket
import ssl
import stat
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

DIGEST=re.compile(r"sha256:([0-9a-f]{64})\Z")
BACKEND_REF=re.compile(r"runtime-allocation:([0-9a-f-]{36}):([1-9][0-9]*):([1-9][0-9]*)\Z")
MAX_BODY=1024*1024

def fail(code): print(code,file=sys.stderr); raise SystemExit(2)
def owned_root(value, marker_name, marker_value):
    path=Path(value)
    try: info=path.lstat(); result=path.resolve(strict=True)
    except OSError: fail("gateway_root_unavailable")
    if not path.is_absolute() or stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or info.st_mode&0o077: fail("gateway_root_invalid")
    try: marker=(result/marker_name).read_text().strip()
    except OSError: fail("gateway_root_not_owned")
    if marker!=marker_value: fail("gateway_root_not_owned")
    return result
def load_regular(path,maximum=512*1024):
    info=path.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_size>maximum: raise ValueError("unsafe file")
    return path.read_bytes()
def valid_manifest(value):
    if not isinstance(value,dict) or value.get("schema")!="hostlet.route-manifest/v1": raise ValueError("schema")
    uuid.UUID(value["project_id"]); uuid.UUID(value["release_id"])
    if not isinstance(value.get("generation"),int) or value["generation"]<=0: raise ValueError("generation")
    return value
def manifest_from(path): return valid_manifest(json.loads(load_regular(path)))

class Gateway(http.server.BaseHTTPRequestHandler):
    protocol_version="HTTP/1.1"
    server_version="HostletOwnedGateway/1"
    sys_version=""
    def log_message(self,fmt,*args):
        print(json.dumps({"event":"gateway_request","client":"loopback","message":fmt%args}),flush=True)
    def active(self):
        current=self.server.route_root/"current.json"
        raw=load_regular(current)
        digest=hashlib.sha256(raw).hexdigest()
        immutable=self.server.route_root/"manifests"/(digest+".json")
        if load_regular(immutable)!=raw: raise ValueError("route pointer integrity")
        value=valid_manifest(json.loads(raw))
        if value["project_id"]!=self.server.project_id: raise ValueError("project")
        return value
    def requested_release(self,active):
        cookie=http.cookies.SimpleCookie(self.headers.get("Cookie",""))
        release=cookie.get("__Host-hostlet_release")
        if release is None: return active
        try: release_id=str(uuid.UUID(release.value))
        except ValueError: return active
        if release_id==active["release_id"]: return active
        expires=active.get("drain_expires_at")
        if not isinstance(expires,str): return active
        # ISO-8601 UTC lexical timestamps are used by control. The gateway's
        # drain decision uses wall time and cannot be extended by policy time.
        try:
            deadline=datetime.fromisoformat(expires.replace("Z","+00:00"))
            if deadline.tzinfo is None: return active
            deadline=deadline.astimezone(timezone.utc).timestamp()
        except ValueError: return active
        if time.time()>deadline: return active
        retained=active.get("retained_assets")
        if not isinstance(retained,list): return active
        retained_frontend=next((item for item in retained
            if isinstance(item,dict) and item.get("release_id")==release_id),None)
        if retained_frontend is None or not DIGEST.fullmatch(retained_frontend.get("archive_digest","")) or not DIGEST.fullmatch(retained_frontend.get("manifest_digest","")): return active
        for path in (self.server.route_root/"manifests").glob("*.json"):
            try:
                raw=load_regular(path)
                if path.stem!=hashlib.sha256(raw).hexdigest(): continue
                value=valid_manifest(json.loads(raw))
                frontend=value.get("frontend")
                if value["project_id"]==self.server.project_id and value["release_id"]==release_id and isinstance(frontend,dict) and frontend.get("archive_digest")==retained_frontend["archive_digest"] and frontend.get("manifest_digest")==retained_frontend["manifest_digest"]: return value
            except Exception: continue
        return active
    def reject(self,status=404,code="not_found"):
        body=json.dumps({"error":code},separators=(",",":")).encode()
        self.send_response(status); self.send_header("Content-Type","application/json"); self.send_header("Content-Length",str(len(body))); self.send_header("Cache-Control","no-store"); self.send_header("Connection","close"); self.end_headers()
        if self.command!="HEAD": self.wfile.write(body)
    def verify_request(self):
        host=self.headers.get("Host","").split(":",1)[0].lower()
        return self.client_address[0] in ("127.0.0.1","::1") and host==self.server.hostname
    def do_GET(self): self.handle_request()
    def do_HEAD(self): self.handle_request()
    def do_POST(self): self.handle_request()
    def do_PUT(self): self.handle_request()
    def do_PATCH(self): self.handle_request()
    def do_DELETE(self): self.handle_request()
    def handle_request(self):
        try:
            if not self.verify_request(): return self.reject(421,"gateway_host_rejected")
            target=urlsplit(self.path)
            if target.scheme or target.netloc or target.fragment or "\\" in target.path: return self.reject(400,"invalid_target")
            active=self.active(); selected=self.requested_release(active)
            if target.path.startswith("/api/") or target.path=="/api": return self.proxy(selected,target)
            if self.command not in ("GET","HEAD"): return self.reject(405,"method_not_allowed")
            return self.static(selected,target.path)
        except Exception as error:
            print(json.dumps({"event":"gateway_failure","reason":type(error).__name__}),file=sys.stderr,flush=True)
            return self.reject(503,"route_unavailable")
    def static(self,route,path):
        frontend=route.get("frontend")
        if frontend is None: return self.reject()
        match=DIGEST.fullmatch(frontend.get("archive_digest", ""))
        if not match: raise ValueError("digest")
        pure=PurePosixPath(path.lstrip("/") or "index.html")
        if any(part in ("",".","..") for part in pure.parts): return self.reject(400,"invalid_target")
        root=self.server.state_root/"release-static"/match.group(1)
        target=root.joinpath(*pure.parts)
        if not target.exists() and "." not in pure.name: target=root/"index.html"
        info=target.lstat()
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode): return self.reject()
        resolved=target.resolve(strict=True)
        if root.resolve(strict=True) not in resolved.parents: return self.reject(400,"invalid_target")
        body=resolved.read_bytes()
        self.send_response(200); self.send_header("Content-Type",mimetypes.guess_type(resolved.name)[0] or "application/octet-stream"); self.send_header("Content-Length",str(len(body)))
        self.send_header("X-Content-Type-Options","nosniff"); self.send_header("Content-Security-Policy","default-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'")
        self.send_header("Set-Cookie",f"__Host-hostlet_release={route['release_id']}; Secure; HttpOnly; SameSite=Lax; Path=/")
        self.send_header("Cache-Control","no-store" if resolved.name=="index.html" else "public, max-age=31536000, immutable")
        self.end_headers()
        if self.command!="HEAD": self.wfile.write(body)
    def relay(self,backend):
        match=BACKEND_REF.fullmatch(backend.get("backend_ref", ""))
        if not match: raise ValueError("backend ref")
        allocation,generation,fence=match.groups()
        if backend.get("allocation_id")!=allocation or backend.get("generation")!=int(generation) or backend.get("fence")!=int(fence): raise ValueError("backend tuple")
        path=self.server.runtime_root/"runtime-relays"/allocation/generation/(fence+".json")
        value=json.loads(load_regular(path,64*1024))
        expected={"schema":"hostlet.runtime.relay-map/v1","allocation_id":allocation,"generation":int(generation),"fence":int(fence),"address":"127.0.0.1"}
        if any(value.get(k)!=v for k,v in expected.items()) or not isinstance(value.get("port"),int) or not 0<value["port"]<65536: raise ValueError("relay map")
        return value["address"],value["port"]
    def proxy(self,route,target):
        backend=route.get("backend")
        if backend is None: return self.reject(503,"backend_unavailable")
        if self.headers.get("Transfer-Encoding") is not None: return self.reject(400,"transfer_encoding_rejected")
        length=int(self.headers.get("Content-Length","0"))
        if length<0 or length>MAX_BODY: return self.reject(413,"body_too_large")
        body=self.rfile.read(length) if length else None
        address,port=self.relay(backend)
        connection=http.client.HTTPConnection(address,port,timeout=8)
        headers={}
        for name in ("Accept","Content-Type","If-None-Match"):
            if name in self.headers: headers[name]=self.headers[name]
        headers["X-Forwarded-Proto"]="https"; headers["X-Hostlet-Release"]=route["release_id"]
        connection.request(self.command,target.path+("?"+target.query if target.query else ""),body=body,headers=headers)
        response=connection.getresponse(); payload=response.read(MAX_BODY+1); connection.close()
        if len(payload)>MAX_BODY: return self.reject(502,"backend_response_too_large")
        self.send_response(response.status)
        for name in ("Content-Type","ETag"):
            value=response.getheader(name)
            if value: self.send_header(name,value)
        self.send_header("Content-Length",str(len(payload))); self.send_header("Cache-Control","no-store"); self.end_headers()
        if self.command!="HEAD": self.wfile.write(payload)

def main():
    parser=argparse.ArgumentParser(); parser.add_argument("--state-root",required=True); parser.add_argument("--runtime-root",required=True); parser.add_argument("--project-id",required=True); parser.add_argument("--hostname",required=True); parser.add_argument("--listen-port",type=int,required=True); parser.add_argument("--certificate",required=True); parser.add_argument("--private-key",required=True)
    args=parser.parse_args(); root=owned_root(args.state_root,".hostlet-release-owned","hostlet-release-state-v1"); runtime_root=owned_root(args.runtime_root,".hostlet-runtime-owned","hostlet-runtime-state-v1")
    try: project=str(uuid.UUID(args.project_id))
    except ValueError: fail("gateway_project_invalid")
    hostname=args.hostname.lower()
    if not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.localowned\.test",hostname): fail("gateway_hostname_invalid")
    for supplied in (args.certificate,args.private_key):
        path=Path(supplied).resolve(strict=True)
        if root not in path.parents or not stat.S_ISREG(path.lstat().st_mode) or stat.S_ISLNK(path.lstat().st_mode): fail("gateway_tls_file_invalid")
    server=http.server.ThreadingHTTPServer(("127.0.0.1",args.listen_port),Gateway); server.state_root=root; server.runtime_root=runtime_root; server.route_root=root/"release-routes"/project; server.project_id=project; server.hostname=hostname
    context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); context.minimum_version=ssl.TLSVersion.TLSv1_2; context.load_cert_chain(args.certificate,args.private_key); server.socket=context.wrap_socket(server.socket,server_side=True)
    print(json.dumps({"schema":"hostlet.release-gateway-ready/v1","hostname":hostname,"address":"127.0.0.1","port":server.server_address[1]}),flush=True); server.serve_forever()
if __name__=="__main__": main()
