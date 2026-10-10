import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import contract from '../shared/feishu-read-build.cjs';

// Fresh release runners build locally. Only exact official inputs; no CLI login,
// installed CLI tree, floating compiler, or binary supplied by another platform.
export async function prepareFeishuReadHelper({root,platform=process.platform,arch=process.arch,fetchImpl=fetch,execute=execFileSync}={}) {
  const goOS={darwin:'darwin',linux:'linux',win32:'windows'}[platform],goArch={arm64:'arm64',x64:'amd64'}[arch];
  if (!root || !goOS || !goArch) throw new Error('feishu_read_build_platform_unsupported');
  const workspace=path.join(root,'data/local/feishu-read-ci');fs.mkdirSync(workspace,{recursive:true,mode:0o700});
  const temporary=fs.mkdtempSync(path.join(workspace,'prepare-'));
  async function download(url,limit) {
    const response=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(120000)});
    if (!response.ok || Number(response.headers.get('content-length')||0)>limit) throw new Error('feishu_read_build_download_failed');
    const chunks=[];let size=0;
    for await (const chunk of response.body) {size+=chunk.length;if(size>limit)throw new Error('feishu_read_build_download_too_large');chunks.push(Buffer.from(chunk));}
    return Buffer.concat(chunks);
  }
  const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
  try {
    const archive=await download(`https://codeload.github.com/larksuite/cli/tar.gz/${contract.FEISHU_READ_BUILD.upstreamCommit}`,32*1024*1024);
    if(sha(archive)!==contract.FEISHU_READ_BUILD.archiveDigest)throw new Error('feishu_read_upstream_archive_mismatch');
    const version=contract.FEISHU_READ_BUILD.compilerVersion;
    const filename=`${version}.${goOS}-${goArch}.${platform==='win32'?'zip':'tar.gz'}`;
    const releases=JSON.parse((await download('https://go.dev/dl/?mode=json&include=all',8*1024*1024)).toString('utf8'));
    const matches=releases.filter(item=>item.version===version).flatMap(item=>item.files).filter(item=>item.filename===filename && item.os===goOS && item.arch===goArch && item.kind==='archive');
    if(matches.length!==1 || !/^[a-f0-9]{64}$/.test(matches[0].sha256))throw new Error('feishu_read_reviewed_compiler_unavailable');
    const compiler=await download(`https://dl.google.com/go/${filename}`,256*1024*1024);
    if(sha(compiler)!==matches[0].sha256 || compiler.length!==matches[0].size)throw new Error('feishu_read_compiler_archive_mismatch');
    const sourcePath=path.join(temporary,'source.tar.gz'),compilerPath=path.join(temporary,filename);
    fs.writeFileSync(sourcePath,archive,{mode:0o600,flag:'wx'});fs.writeFileSync(compilerPath,compiler,{mode:0o600,flag:'wx'});
    execute('tar',['-xf',compilerPath,'-C',temporary],{stdio:'inherit'});
    execute(process.execPath,[path.join(root,'desktop-channel-mvp/tools/build-feishu-read-helper.mjs'),'--source-archive',sourcePath,'--go',path.join(temporary,'go/bin',platform==='win32'?'go.exe':'go')],{cwd:root,stdio:'inherit'});
  } finally {fs.rmSync(temporary,{recursive:true,force:true});}
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await prepareFeishuReadHelper({root:path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')});
