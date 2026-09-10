/** D15 R02-2A segmented entrypoint: one short fixture lifecycle per logic group. */
const path=require('path');
const {spawnSync}=require('child_process');

const segment=process.argv[process.argv.indexOf('--segment')+1];
if(!['organization','supersede'].includes(segment)){
  console.error('usage: node d15-r02-organization-cycle.js --segment organization|supersede');
  process.exit(2);
}
const runner=path.join(__dirname,'d15-electronic-signature-evidence.js');
const run=spawnSync(process.execPath,[runner,`--segment=${segment}`],{encoding:'utf8',windowsHide:true,env:process.env});
process.stdout.write(run.stdout||'');
process.stderr.write(run.stderr||'');
const output=`${run.stdout||''}\n${run.stderr||''}`;
if(run.status!==0||!output.includes('cleanup residual = 0'))process.exit(1);
console.log(`D15_R02_2A_SEGMENT PASS segment=${segment}`);
