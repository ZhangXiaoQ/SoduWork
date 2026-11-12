# 包内应用的持久文件空间（SDK 1.7）

适用本地数据（jiyong.storage.location=local）的包内应用。沿用 data.read/data.write 授权；无任意磁盘路径、HTTP 服务或新会话。外部 H5 与云端文件当前不适用。

```js
// 先让用户看到预览，不等待存储。
const preview = URL.createObjectURL(file);
image.src = preview;
// 后台持久化，不用 data.assetGet 再取完整字节。
const result = await soduWorkApp.files.importFile(file, {
  projectId: project.id,
  onProgress: ({loaded,total}) => updateFileProgress(loaded,total)
});
if (!result.ok) throw Error(result.reason);
await saveRecord({fileId:result.file.id,projectId:project.id});
// 重开时查元数据得到 URL，浏览器直接读文件。
const saved = await soduWorkApp.files.getUrl({projectId:project.id,id:fileId});
image.src = saved.file.url;
```

文件保存在账号与应用隔离目录 `jiyong-files/<scope>/projects/<projectHash>/files/`，原始二进制是普通图片/视频文件，JSON 元数据相邻保存，不进入数据库。数据库只存 fileId/projectId 等引用。项目ID不是任意路径。

URL形式为同源 `/_app-files/<projectHash>/<fileId>/<name>`。每次资源请求核对已安装入口、data.read、当前账号/来源与文件归属；停用应用、换账号或撤权后新请求失效。媒体按需流式读取，支持GET/HEAD、ETag/304和单段Range/206/416；Cache-Control private,no-cache让缓存重验授权。HTML/JS等可执行文件按二进制附件下载，不能借文件地址运行应用脚本。

importFile内部调用files.begin/append/finish，512KiB有序分块、256MiB单文件上限、每应用最多4个上传。finish在落盘和元数据写入后返回，当前原生进程内重复finish复用同一结果；写入未确认不自动另起导入。可传signal停止下一块，失败保留页面预览并提示，后台保存失败不能宣称项目已保存。只有文件完成后才保存业务引用。

文件保存与数据集合相互独立；暂不提供通用文件删除、引用计数或云同步，不把临时attachments接口当作持久文件。静态安装包资源路径与动态文件路径分离，动态文件不进入应用安装包。

## 本机图片选择与原生复制（当前源码新增）

files.pickLocal() 弹出原生图片选择器，返回 items 的 sourceId/name/type/size/url，取消返回空数组；url 为 /_app-sources/ 临时预览，不是项目文件，引用24小时过期。files.copyLocal({projectId,sourceId}) 在主进程以原生文件复制保存项目副本，返回与 importFile 相同的 file 元数据及持久URL。仅保存时调用；sourceId不能替换为路径，原文件变化/移动会失败；不要把临时URL存为持久引用。包内本地数据应用受 data.read/write 和当前安装来源/账号限制。剪贴板Blob依然用 importFile。该能力需要重启包含新源码的客户端，不是任意Shell执行接口。
