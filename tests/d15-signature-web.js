const fs = require('fs');
const path = require('path');

const read = file => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
const index = read('index.html');
const training = read('js/modules/training/training.js');
const evidence = read('js/modules/training/signature-evidence.js');
const mine = read('js/modules/training/mine.js');
let passed = 0;
const check = (name, ok) => {
  if (!ok) throw new Error(`FAIL D15-WEB ${name}`);
  passed += 1;
  console.log(`PASS D15-WEB ${String(passed).padStart(2, '0')} ${name}`);
};

check('signature module is loaded', index.includes('js/modules/training/signature-evidence.js'));
check('training center exposes signature tab', training.includes("key: 'signatures'") && training.includes('TrainingSignatureEvidence.mount'));
check('prepare RPC drives summary', evidence.includes("training_signature_prepare") && evidence.includes('evidence_digest'));
check('canvas supports pre-submit clearing', evidence.includes('d15-sign-canvas') && evidence.includes('clearCanvas'));
check('upload is PNG and non-overwriting', evidence.includes("contentType:'image/png'") && evidence.includes('upsert:false'));
check('submit uses server challenge', evidence.includes("training_signature_submit") && evidence.includes('p_challenge_id:p.challenge_id'));
check('upload invokes server byte validation before submit', evidence.includes("sb.functions.invoke('d15-validate-signature'") && evidence.indexOf("d15-validate-signature") < evidence.indexOf("training_signature_submit"));
check('history opens through authorized file RPC', evidence.includes('training_signature_result_file') && evidence.includes('createSignedUrl'));
check('company admin has controlled policy actions', ['training_signature_policy_create', 'training_signature_policy_save_draft', 'training_signature_policy_publish', 'training_signature_policy_create_version', 'training_signature_policy_retire'].every(name => evidence.includes(name)));
check('legacy signature submit action is removed', !mine.includes("rpc('training_submit_signature'") && !mine.includes('saveSign('));
check('browser never decides digest or completion', !evidence.includes('crypto.subtle') && !evidence.includes("exam_status:'passed'"));

console.log(`D15_WEB PASS ${passed}/${passed}`);
