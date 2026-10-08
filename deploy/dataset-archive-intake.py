#!/usr/bin/python3
"""Single-archive campus intake. Never extract into an existing dataset tree."""
import gzip
import hashlib
import io
import os
from pathlib import Path
import re
import shutil
import stat
import struct
import tarfile
import uuid
import zipfile

FORMATS = ('zip', 'tar', 'tar.gz')
CHUNK = 1024**2
UUID_TEXT = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')


class ArchiveError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.reasonCode = code


def fail(code, message):
    raise ArchiveError(code, message)


def specification(value, total, entries):
    if (not isinstance(value, dict) or set(value) != {'protocol','fileName','format','bytes','sha256'}
            or type(value.get('protocol')) is not int or value['protocol'] != 1
            or not isinstance(value.get('fileName'), str) or not 1 <= len(value['fileName'].encode()) <= 255
            or re.search(r'[\\/\x00-\x1f\x7f]', value['fileName']) or value['fileName'] in ('.','..')
            or value.get('format') not in FORMATS
            or not (value['fileName'].lower().endswith('.'+value['format'])
                    or value['format'] == 'tar.gz' and value['fileName'].lower().endswith('.tgz'))
            or type(value.get('bytes')) is not int or value['bytes'] < 1 or value['bytes'] != total or entries != 1
            or not isinstance(value.get('sha256'), str) or not re.fullmatch('[a-f0-9]{64}', value['sha256'])):
        fail('ARCHIVE_FORMAT_UNSUPPORTED', '压缩包规格无效')
    return {key:value[key] for key in ('protocol','fileName','format','bytes','sha256')}


def safe_path(raw):
    if not isinstance(raw, str) or not raw or raw.startswith(('/', '\\')) or re.match(r'^[A-Za-z]:',raw) or re.search(r'[\\\x00-\x1f\x7f]',raw):
        fail('ARCHIVE_UNSAFE_PATH','压缩包包含不安全路径')
    # tar commonly spells ordinary relative paths ./train.csv.
    bits=raw.rstrip('/').split('/')
    if '..' in bits or any(bit in ('.ssh','.env','.git','.venv','anaconda3','miniconda3','.conda') for bit in bits):
        fail('ARCHIVE_UNSAFE_PATH','压缩包包含不安全路径')
    while bits and bits[0]=='.': bits.pop(0)
    if not bits: return None
    if any(not bit or bit=='.' for bit in bits) or len('/'.join(bits).encode())>4096:
        fail('ARCHIVE_UNSAFE_PATH','压缩包包含不安全路径')
    return '/'.join(bits)


class BoundedReader:
    def __init__(self, stream, limit): self.stream,self.limit,self.used=stream,limit,0
    def read(self, size):
        if size<0 or size>CHUNK: fail('ARCHIVE_TOO_LARGE','压缩包元数据过大')
        result=self.stream.read(min(size,self.limit-self.used+1));self.used+=len(result)
        if self.used>self.limit: fail('ARCHIVE_TOO_LARGE','解压后的数据过大')
        return result


def exact(stream,size):
    value=bytearray()
    while len(value)<size:
        part=stream.read(min(CHUNK,size-len(value)))
        if not part: fail('ARCHIVE_CORRUPT','压缩包内容不完整')
        value.extend(part)
    return bytes(value)


def consume(stream,size,sink=None):
    while size:
        part=stream.read(min(CHUNK,size))
        if not part: fail('ARCHIVE_CORRUPT','压缩包内容不完整')
        if sink: sink(part)
        size-=len(part)


def pax_values(raw):
    values={};at=0
    while at<len(raw):
        end=raw.find(b' ',at,at+24)
        if end<0: fail('ARCHIVE_CORRUPT','压缩包元数据损坏')
        try: length=int(raw[at:end]);entry=raw[end+1:at+length].decode('utf-8')
        except (ValueError,UnicodeError): fail('ARCHIVE_CORRUPT','压缩包元数据损坏')
        if length<=end-at+1 or at+length>len(raw) or not entry.endswith('\n') or '=' not in entry:
            fail('ARCHIVE_CORRUPT','压缩包元数据损坏')
        key,value=entry[:-1].split('=',1)
        if key.startswith('GNU.sparse') or key=='linkpath': fail('ARCHIVE_UNSAFE_PATH','压缩包包含链接或特殊文件')
        if key in values: fail('ARCHIVE_CORRUPT','压缩包元数据重复')
        values[key]=value;at+=length
    return values


def tar_entries(raw,compressed,max_bytes,max_entries,visit):
    stream=gzip.GzipFile(fileobj=raw) if compressed else raw
    reader=BoundedReader(stream,max_bytes+max_entries*4096+65536)
    pending={};metadata=0
    try:
        while True:
            block=exact(reader,512)
            if not any(block):
                if any(exact(reader,512)): fail('ARCHIVE_CORRUPT','压缩包结束标记损坏')
                while True:
                    extra=reader.read(CHUNK)
                    if not extra: break
                    if any(extra): fail('ARCHIVE_CORRUPT','压缩包末尾有未校验内容')
                break
            try: info=tarfile.TarInfo.frombuf(block,'utf-8','strict')
            except (tarfile.TarError,ValueError,UnicodeError): fail('ARCHIVE_CORRUPT','压缩包头损坏')
            if info.size<0: fail('ARCHIVE_CORRUPT','压缩包大小无效')
            if info.type in (tarfile.XHDTYPE,tarfile.GNUTYPE_LONGNAME):
                metadata+=1
                if info.size>65536 or metadata>max_entries*2+16: fail('ARCHIVE_TOO_LARGE','压缩包元数据过大')
                data=exact(reader,info.size);consume(reader,(-info.size)%512)
                if info.type==tarfile.XHDTYPE: pending.update(pax_values(data))
                else:
                    try: pending['path']=data.rstrip(b'\0').decode('utf-8')
                    except UnicodeError: fail('ARCHIVE_UNSAFE_PATH','压缩包路径无效')
                continue
            if not info.isreg() and not info.isdir(): fail('ARCHIVE_UNSAFE_PATH','压缩包包含链接或特殊文件')
            path=safe_path(pending.get('path',info.name))
            try: size=int(pending.get('size',info.size))
            except ValueError: fail('ARCHIVE_CORRUPT','压缩包大小无效')
            pending={}
            if size<0 or size>max_bytes or info.isdir() and size: fail('ARCHIVE_TOO_LARGE','解压后的数据过大')
            if path is None:
                if not info.isdir(): fail('ARCHIVE_UNSAFE_PATH','压缩包路径为空')
                continue
            sink=visit(path,info.isdir(),size)
            consume(reader,size,sink);consume(reader,(-size)%512)
    finally:
        if compressed: stream.close()


def zip_bounds(raw,size,max_entries):
    raw.seek(max(0,size-65557));tail=raw.read(65557);at=tail.rfind(b'PK\x05\x06')
    if at<0 or len(tail)-at<22: fail('ARCHIVE_CORRUPT','ZIP结束标记损坏')
    disk,cd_disk,on_disk,count,cd_size,offset,comment=struct.unpack_from('<4H2LH',tail,at+4)
    if len(tail)-at!=22+comment or disk or cd_disk: fail('ARCHIVE_CORRUPT','ZIP结构不支持')
    if count==65535 or cd_size==0xffffffff or offset==0xffffffff:
        end=size-len(tail)+at
        if end<20: fail('ARCHIVE_CORRUPT','ZIP64结束标记损坏')
        raw.seek(end-20);locator=raw.read(20)
        if len(locator)!=20 or locator[:4]!=b'PK\x06\x07': fail('ARCHIVE_CORRUPT','ZIP64结束标记损坏')
        disk,position,disks=struct.unpack_from('<LQL',locator,4)
        if disk or disks!=1 or position+56>end-20: fail('ARCHIVE_CORRUPT','ZIP64结构不支持')
        raw.seek(position);record=raw.read(56)
        if len(record)!=56 or record[:4]!=b'PK\x06\x06': fail('ARCHIVE_CORRUPT','ZIP64结束标记损坏')
        length,_,_,disk,cd_disk,on_disk,count,cd_size,offset=struct.unpack_from('<Q2H2L4Q',record,4)
        if length<44 or length>1024 or disk or cd_disk: fail('ARCHIVE_CORRUPT','ZIP64结构不支持')
    if count!=on_disk or count>max_entries or cd_size>64*1024**2 or offset+cd_size>size:
        fail('ARCHIVE_TOO_LARGE','压缩包文件过多或元数据过大')
    raw.seek(0)


def zip_entries(raw,size,max_bytes,max_entries,visit):
    zip_bounds(raw,size,max_entries)
    with zipfile.ZipFile(raw) as archive:
        if len(archive.infolist())>max_entries: fail('ARCHIVE_TOO_LARGE','压缩包文件过多')
        for info in archive.infolist():
            kind=stat.S_IFMT(info.external_attr>>16)
            if kind not in (0,stat.S_IFREG,stat.S_IFDIR) or info.flag_bits&1:
                fail('ARCHIVE_UNSAFE_PATH','压缩包包含链接、特殊文件或加密内容')
            if info.compress_type not in (zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED): fail('ARCHIVE_FORMAT_UNSUPPORTED','ZIP压缩算法不支持')
            directory=info.is_dir();path=safe_path(info.filename)
            if path is None:
                if not directory: fail('ARCHIVE_UNSAFE_PATH','压缩包路径为空')
                continue
            if info.file_size>max_bytes or directory and info.file_size: fail('ARCHIVE_TOO_LARGE','解压后的数据过大')
            sink=visit(path,directory,info.file_size)
            if not directory:
                with archive.open(info) as stream:
                    consume(stream,info.file_size,sink)
                    if stream.read(1): fail('ARCHIVE_CORRUPT','ZIP大小不符')


def inspect_archive(path,format,max_bytes,max_entries,output=None,max_metadata=32*1024**2):
    directories=set();files={};explicit=set();total=0;handles=[];metadata=32
    def charge(name, allowance):
        nonlocal metadata
        metadata+=2*len(name.encode('utf-8'))+allowance
        if metadata>max_metadata: fail('ARCHIVE_TOO_LARGE','解压清单过大')
    def add_directory(name):
        if name not in directories:
            charge(name,8);directories.add(name)
    def visit(name,directory,size):
        nonlocal total
        if name in explicit or name in files or not directory and name in directories:
            fail('ARCHIVE_UNSAFE_PATH','压缩包路径重复或冲突')
        explicit.add(name)
        bits=name.split('/')
        for i in range(1,len(bits)):
            parent='/'.join(bits[:i])
            if parent in files: fail('ARCHIVE_UNSAFE_PATH','压缩包路径冲突')
            add_directory(parent)
        if directory: add_directory(name)
        else:
            charge(name,160);total+=size;files[name]={'path':name,'size':size}
        if total>max_bytes or len(directories)+len(files)>max_entries: fail('ARCHIVE_TOO_LARGE','解压后的大小或文件数超出上限')
        if output is None or directory: return None
        target=output/name;target.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
        fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);hash=hashlib.sha256();written=0
        handles.append(fd)
        def sink(data):
            nonlocal written
            hash.update(data);at=0
            while at<len(data): at+=os.write(fd,data[at:])
            written+=len(data)
            if written==size: os.fsync(fd);os.close(fd);handles.remove(fd);files[name]['sha256']=hash.hexdigest()
        if not size: os.fsync(fd);os.close(fd);handles.remove(fd);files[name]['sha256']=hash.hexdigest()
        return sink
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        before=os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1: fail('ARCHIVE_UNSAFE_PATH','压缩包不是独立普通文件')
        with os.fdopen(os.dup(fd),'rb') as raw:
            if format=='zip': zip_entries(raw,before.st_size,max_bytes,max_entries,visit)
            else: tar_entries(raw,format=='tar.gz',max_bytes,max_entries,visit)
        after=os.fstat(fd)
        if (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns): fail('ARCHIVE_CORRUPT','压缩包在解压期间改变')
        if not files: fail('ARCHIVE_EMPTY','压缩包没有数据文件')
        if output:
            for directory in sorted(directories): (output/directory).mkdir(mode=0o700,parents=True,exist_ok=True)
        return {'schema':1,'directories':sorted(directories),'files':[files[key] for key in sorted(files)]},total
    except (OSError,EOFError,zipfile.BadZipFile,RuntimeError) as error:
        if isinstance(error,ArchiveError): raise
        fail('ARCHIVE_CORRUPT','压缩包损坏或无法读取')
    finally:
        for handle in handles: os.close(handle)
        os.close(fd)


class ArchiveIntake:
    def __init__(self,uploads): self.u=uploads
    def capability(self):
        u=self.u;policy=u.n.CONFIG.get('storageArchive',{});config=u.n.CONFIG.get('datasets',{}).get('archiveUpload',{})
        if not isinstance(config,dict) or config.get('enabled') is not True: return None
        if set(config)-{'enabled','maxExpandedBytes','maxEntries'} or any(type(config.get(key,default)) is not int or not 1<=config.get(key,default)<=default for key,default in (('maxExpandedBytes',u.limits['maxUploadBytes']),('maxEntries',u.d.MAX_ENTRIES))): raise ValueError('Invalid trusted archive intake limits')
        if u.cache_only() or u.n.CONFIG.get('storageAuthority',{}).get('enabled') is not True or policy.get('enabled') is not True or policy.get('machine')!=u.n.CONFIG.get('machine'): return None
        return {'protocol':1,'formats':list(FORMATS),'maxBytes':u.limits['maxUploadBytes']}
    def limits(self):
        config=self.u.n.CONFIG.get('datasets',{}).get('archiveUpload',{})
        return config.get('maxExpandedBytes',self.u.limits['maxUploadBytes']),config.get('maxEntries',self.u.d.MAX_ENTRIES)
    def file(self,session): return self.u.folder(session['userId'],session['uploadId'])/'archive.part'
    def reservation(self,session): return self.u.reservation(session['userId'],session['uploadId']).with_name(hashlib.sha256((self.u.key(session['userId'],session['uploadId'])+'-expanded').encode()).hexdigest()+'.json')
    def work(self,session): return self.u.folder(session['userId'],session['uploadId'])/'archive-extract'
    def recover_chunk(self, session, size, reservation):
        u=self.u;journal=u.folder(session['userId'],session['uploadId'])/'archive-chunk.json'
        try: intent=u.d._read_json(journal)
        except FileNotFoundError: return reservation
        if (not isinstance(intent,dict) or set(intent)!={'beforeOffset','length'}
                or any(type(intent[key]) is not int or intent[key]<0 for key in intent)
                or not intent['beforeOffset']<=size<=intent['beforeOffset']+intent['length']<=session['archive']['bytes']):
            raise ValueError('Archive append journal changed')
        def reserved(at): return {'bytes':session['reserveBytes']-at,'budgetBytes':session['reserveBytes'],'inodes':session['entries']+16}
        if reservation not in (reserved(intent['beforeOffset']),reserved(size)):
            raise ValueError('Archive append reservation changed')
        reservation=reserved(size);u.d._write_json(u.reservation(session['userId'],session['uploadId']),reservation);u._unlink(journal)
        return reservation
    def seal(self,session,manifest):
        value=specification(session['archive'],session['totalBytes'],session['entries'])
        if manifest['directories'] or manifest['files']!=[{'path':value['fileName'],'size':value['bytes'],'sha256':value['sha256']}]: fail('ARCHIVE_CORRUPT','压缩包与准入清单不符')
        session.update(state='UPLOADING',archivePhase='UPLOADING',archiveSealed=True);self.u.save(session)
    def entry(self,session,path):
        if not session.get('archiveSealed') or path!=session['archive']['fileName']: raise ValueError('Archive path differs from its sealed specification')
        return {'path':path,'size':session['archive']['bytes'],'sha256':session['archive']['sha256']}
    def chunk(self,user,args,offset,data,transport,authorize):
        if transport!='campus-direct': fail('CAMPUS_ROUTE_UNAVAILABLE','压缩包只走校内直连')
        u=self.u
        with u.guard(user,args['uploadId']):
            session=u.load(user,args['uploadId']);u._check_admission(session);u.require_ingress(user,args['uploadId'],session)
            if session['state']!='UPLOADING' and not (session['state']=='FAILED' and session.get('resumeState')=='UPLOADING'): raise ValueError('Archive is not accepting file bytes')
            entry=self.entry(session,args['path'])
            if offset+len(data)>entry['size']: raise ValueError('Archive chunk exceeds admitted size')
            if authorize: authorize()
            with u.cache._locked():
                previous=u._size(self.file(session))
                reservation=u.d._read_json(u.reservation(user,args['uploadId']))
                reservation=self.recover_chunk(session,previous,reservation)
                expected={'bytes':session['reserveBytes']-previous,'budgetBytes':session['reserveBytes'],'inodes':session['entries']+16}
                if reservation!=expected: raise ValueError('Archive reservation changed')
                u.cache._free(u.cache._reserved()+8192)
                with u.d._directory(u.folder(user,args['uploadId'])) as parent:
                    fd=os.open('archive.part',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600,dir_fd=parent)
                    try:
                        size=u.d._regular(fd).st_size
                        if offset+len(data)<=size and os.pread(fd,len(data),offset)==data: pass
                        elif offset==size:
                            u.d._write_json(u.folder(user,args['uploadId'])/'archive-chunk.json',{'beforeOffset':size,'length':len(data)})
                            at=0
                            while at<len(data): at+=os.pwrite(fd,data[at:],offset+at)
                            os.fsync(fd);size=offset+len(data)
                        else: raise ValueError('Archive offset differs; query the original upload UUID')
                    finally: os.close(fd)
                u.d._write_json(u.reservation(user,args['uploadId']),{'bytes':session['reserveBytes']-size,'budgetBytes':session['reserveBytes'],'inodes':session['entries']+16})
                u._unlink(u.folder(user,args['uploadId'])/'archive-chunk.json')
            if session['state']=='FAILED':
                session.update(state='UPLOADING',archivePhase='UPLOADING');session.pop('error',None);session.pop('resumeState',None);session.pop('reasonCode',None);u.save(session)
            u.confirm_route(session,transport)
            return {**u.result(session),'offset':offset+len(data),'complete':size==entry['size']}
    def status(self,session,path):
        entry=self.entry(session,path);size=entry['size'] if session['state']=='READY' else self.u._size(self.file(session))
        if size>entry['size']: raise ValueError('Archive exceeds admitted size')
        return {**entry,'offset':size,'complete':size==entry['size']}
    def prepare(self,session):
        u=self.u;u._check_admission(session)
        fd=os.open(self.file(session),os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        try: digest,size=u.d._digest_fd(fd)
        finally: os.close(fd)
        with u.cache._locked():
            self.recover_chunk(session,size,u.d._read_json(u.reservation(session['userId'],session['uploadId'])))
        if size!=session['archive']['bytes'] or digest!=session['archive']['sha256']: fail('ARCHIVE_CORRUPT','压缩包长度或校验值不符')
        session['archivePhase']='EXTRACTING';session.pop('reasonCode',None);u.save(session)
        max_bytes,max_entries=self.limits()
        planned,total=inspect_archive(self.file(session),session['archive']['format'],max_bytes,max_entries,max_metadata=u.d.MAX_JSON_BYTES)
        work=self.work(session)
        if work.exists(): shutil.rmtree(work)
        count=len(planned['directories'])+len(planned['files']);metadata=len(u.d._json_bytes(planned))+count*80
        if metadata>u.d.MAX_JSON_BYTES: fail('ARCHIVE_TOO_LARGE','解压清单过大')
        reserve=total+count*8192+metadata*4+65536
        with u.cache._locked():
            # Account for all this principal's retained uploads, not only the
            # compressed transport size of the current archive.
            retained=[]
            with u.d._directory(u.folder(session['userId'],session['uploadId']).parent) as parent:
                for name in os.listdir(parent):
                    if name==session['uploadId'] or not UUID_TEXT.fullmatch(name): continue
                    try: other=u.load(session['userId'],name)
                    except FileNotFoundError: continue
                    if other['state']!='DISCARDED': retained.append(other)
            quota=u.limits['maxUserBytes']
            if quota and sum(other['reserveBytes']+other.get('expandedReserveBytes',0) for other in retained)+reserve+session['reserveBytes']>quota:
                fail('ARCHIVE_TOO_LARGE','解压后的数据超过个人容量上限')
            if sum(max(other['entries'],other.get('expandedEntries',0)) for other in retained)+count>u.limits['maxUserEntries']:
                fail('ARCHIVE_TOO_LARGE','解压后的文件数超过个人上限')
            u._unlink(self.reservation(session))
            u.cache._budget(reserve)
            u.cache._free(u.cache._reserved()+reserve,needed_inodes=count+16)
            u.d._write_json(self.reservation(session),{'bytes':reserve,'budgetBytes':reserve,'inodes':count+16})
            session.update(expandedReserveBytes=reserve,expandedEntries=count);u.save(session)
        work.mkdir(mode=0o700)
        manifest,actual=inspect_archive(self.file(session),session['archive']['format'],max_bytes,max_entries,work,max_metadata=u.d.MAX_JSON_BYTES)
        if actual!=total or manifest['directories']!=planned['directories'] or [{k:f[k] for k in ('path','size')} for f in manifest['files']]!=planned['files']: fail('ARCHIVE_CORRUPT','压缩包解压清单不一致')
        manifest=u.d._manifest(manifest)
        with u.cache._locked(): u.d._write_json(self.reservation(session),{'bytes':reserve-total,'budgetBytes':reserve,'inodes':16})
        session.update(archivePhase='VERIFYING',expandedBytes=total,expandedEntries=count);u.save(session)
        u.seal(session,_archive_manifest=manifest,_archive_data=work)
        with u.cache._locked(): u._unlink(self.reservation(session))
    def stage(self,session,manifest,data):
        u=self.u;paths=u.cache._paths(session['dataset'],session['version']);stage=paths['.staging']
        if u._exists(paths['ready']) or u._exists(stage): return
        u.d._mkdir(stage)
        if getattr(u.cache,'quota_guard',None): u.cache.quota_guard(u.actor(session['userId']),session['dataset'],stage)
        transfer={'schema':u.d.SCHEMA,'owner':session['userId'],'token':str(uuid.uuid4()),'remainingBytes':0,'totalBytes':sum(f['size'] for f in manifest['files'])}
        u.d._write_json(stage/'TRANSFER.json',transfer)
        u.d._rename_new(data,stage/'data')
    def cleanup(self,session):
        u=self.u
        for path in (self.file(session),self.reservation(session)): u._unlink(path)
        work=self.work(session)
        if work.exists(): shutil.rmtree(work)
