const fs = require('fs');
const path = require('path');

const contractPath = path.resolve(__dirname, '../docs/contracts/D15-electronic-signature-evidence-v1.json');
const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
const checks = [];
const check = (name, ok) => {
  if (!ok) throw new Error(`FAIL D15-CONTRACT ${name}`);
  checks.push(name);
  console.log(`PASS D15-CONTRACT ${String(checks.length).padStart(2, '0')} ${name}`);
};

check('version and pass status', contract.version === 'D15-electronic-signature-evidence-v1' && contract.status === 'pass');
check('legal scope is limited', /system-internal/.test(contract.legal_scope) && /no claim/.test(contract.legal_scope));
check('downstream consumers declared', ['D16', 'D17', 'D18', 'D21', 'D22', 'G2'].every(item => contract.consumers.includes(item)));
check('four controlled node types', Object.keys(contract.controlled_nodes).length === 4);
check('project signer is ANY_OF', contract.controlled_nodes.project_manager_or_safety_confirmation.mode === 'ANY_OF');
check('published versions freeze', /immutable/.test(contract.policy.versioning));
check('future policy has no effective gap', /future V2/.test(contract.policy.versioning) && /V1/.test(contract.policy.versioning));
check('client cannot create requirements', contract.requirement.client_creation === 'forbidden');
check('project binding is authoritative', /Snapshot authoritative actual_project/.test(contract.requirement.source));
check('prepare and submit are declared', ['training_signature_prepare', 'training_signature_submit'].every(name => contract.rpcs.some(rpc => rpc.name === name)));
check('digest is server SHA-256', contract.evidence_digest.algorithm === 'SHA-256' && contract.security.client_digest_input === false);
check('file formats are passive images', contract.file.accepted_mime.length === 2 && contract.file.accepted_mime.includes('image/png') && contract.file.accepted_mime.includes('image/jpeg'));
check('file is private and immutable', contract.file.overwrite === false && contract.file.ordinary_update_delete === false && /private/.test(contract.file.read));
check('file bytes are server decoded and metadata is untrusted', /untrusted/.test(contract.file.trust) && /fully decodes PNG\/JPEG/.test(contract.file.validation) && /SHA-256/.test(contract.file.validation) && /unvalidated objects are rejected/.test(contract.file.submit_requirement));
check('stable signer identity is permanent', contract.identity.permanent.includes('signer_stable_subject_id'));
check('supersede preserves history', /old requirements.*audit remain/.test(contract.supersede));
check('organization signer is scoped and revoke-aware', contract.controlled_nodes.organization_responsible_confirmation.scope === 'organization_unit' && contract.controlled_nodes.organization_responsible_confirmation.company_admin_default === false && /revocation/.test(contract.controlled_nodes.organization_responsible_confirmation.submit_revalidation));
check('supersede rebuilds one authoritative full cycle', /complete new cycle/.test(contract.supersede) && contract.rpcs.some(rpc => rpc.name === 'training_signature_supersede_cycle' && /complete node set/.test(rpc.effect) && /concurrent/.test(rpc.idempotency)));
check('server signed_at is digest-bound and idempotent', /server timestamptz/.test(contract.prepare_submit.signed_at_binding) && contract.evidence_digest.binds.includes('authoritative_server_signed_at_utc') && /original signed_at and digest/.test(contract.prepare_submit.idempotency));
check('hard prerequisites cannot be configured away', /cannot waive/.test(contract.prerequisites.hard_invariants));
check('D13 exam binding is exact', /semantic type/.test(contract.prerequisites.exam_binding) && /exam plan/.test(contract.prerequisites.exam_binding));
check('all stable reason codes declared', contract.reason_codes.length === 13 && contract.reason_codes.every(code => code.startsWith('signature_')));
check('signature cannot change training exam or eligibility', /never completes training/.test(contract.boundary) && /D13 score/.test(contract.boundary) && /D18 work eligibility/.test(contract.boundary));

console.log(`D15_CONTRACT PASS ${checks.length}/${checks.length}`);
