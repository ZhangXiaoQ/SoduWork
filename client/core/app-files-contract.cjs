'use strict';
const CHUNK_BYTES = 512 * 1024, MAX_BYTES = 256 * 1024 * 1024;
const ID = /^file_[a-f0-9]{32}$/, UPLOAD = /^upload_[a-f0-9]{32}$/;
function normalize(method, p) {
  const allowed = { 'files.pickLocal':[], 'files.copyLocal':['projectId','sourceId'], 'files.begin':['projectId','name','type','size'], 'files.append':['id','offset','data'],
    'files.finish':['id'], 'files.cancel':['id'], 'files.getUrl':['projectId','id'] }[method];
  if (!allowed || !p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some(k => !allowed.includes(k))) throw Error('文件请求参数无效');
  if (['files.begin','files.getUrl','files.copyLocal'].includes(method) && (typeof p.projectId !== 'string' || !p.projectId.trim() || p.projectId.length > 160 || /[\x00-\x1f]/.test(p.projectId))) throw Error('文件缺少有效项目标识');
  if(method==='files.pickLocal')return {};
  if(method==='files.copyLocal'){if(!/^source_[a-f0-9]{32}$/.test(p.sourceId||''))throw Error('本地图片引用无效');return {...p};}
  if (method === 'files.begin') {
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 240 || /[\x00-\x1f]/.test(p.name) || typeof p.type !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(p.type) || !Number.isSafeInteger(p.size) || p.size < 0 || p.size > MAX_BYTES) throw Error('文件名称、类型或大小无效');
    if(['.','..',''].includes(p.name.replace(/.*[/\\]/,'')))throw Error('文件名称无效');
  } else if (!(method === 'files.getUrl' ? ID : UPLOAD).test(p.id || '')) throw Error('文件标识无效');
  if (method === 'files.append') {
    if (!Number.isSafeInteger(p.offset) || p.offset < 0 || p.offset > MAX_BYTES) throw Error('文件写入位置无效');
    if (!(p.data instanceof Uint8Array) && !(Array.isArray(p.data) && p.data.every(n => Number.isInteger(n) && n >= 0 && n <= 255))) throw Error('文件分块无效');
    const data = Uint8Array.from(p.data);
    if (!data.length || data.length > CHUNK_BYTES) throw Error('文件分块超过512KiB');
    return {...p, data};
  }
  return {...p};
}
module.exports = {normalize, CHUNK_BYTES, MAX_BYTES, ID};
