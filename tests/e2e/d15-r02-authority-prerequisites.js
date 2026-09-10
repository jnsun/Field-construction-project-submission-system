/** D15 R02-1 focused entrypoint. The authoritative D15 fixture owns setup and cleanup. */
const path=require('path');
const {spawnSync}=require('child_process');

const target=path.join(__dirname,'d15-electronic-signature-evidence.js');
const run=spawnSync(process.execPath,[target],{encoding:'utf8',windowsHide:true});
process.stdout.write(run.stdout||'');
process.stderr.write(run.stderr||'');
const output=`${run.stdout||''}\n${run.stderr||''}`;
const required=['R02-01','R02-02','R02-03','R02-04','R02-05','R02-06','R02-07'];
const missing=required.filter(code=>!output.includes(`PASS D15 ${code}`));
if(run.status!==0||missing.length){
  console.error(`D15_R02_1 FAIL missing=${missing.join(',')||'none'} child_exit=${run.status}`);
  process.exit(1);
}
console.log(`D15_R02_1 PASS ${required.length}/${required.length}`);
