'use strict';
// Only a main-process native file selection can authorize reading adjacent resources.
const path=require('node:path');
const { MAX_PACKAGE_BYTES } = require('./plugin-package-limits.cjs');
async function choose(dialog){
 const result=await dialog.showOpenDialog(require("./native-locale.cjs").dialogOptions({title:'选择本机插件',properties:['openFile'],
  filters:[{name:'SoduWork 插件',extensions:['json','zip','soduwork-plugin']}]}));
 if(result.canceled||!result.filePaths?.length)return {canceled:true};
 const file=path.resolve(result.filePaths[0]);
 return require('./app-resource-cache.cjs').request({action:'import-file',file});
}
module.exports={choose,MAX_PACKAGE_BYTES};
