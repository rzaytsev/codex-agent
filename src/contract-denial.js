// Stable application-owned validation outcomes. Neither raw errors nor caller
// text determines their code/message; unexpected failures retain their own type.
const messages=Object.freeze({
  action_denied:'Action denied',
  memory_primary_evidence_required:'Confirmed memory needs primary or confirmed evidence',
  memory_source_forgotten:'Forgotten source cannot be reused',
  memory_tombstoned:'Forgotten memory remains tombstoned; restoration is disabled',
  learning_owner_evidence_required:'Profile learning needs explicit owner evidence',
  learning_outcome_required:'Promotion needs a host outcome receipt',
  learning_feedback_invalid:'Feedback needs current revision and explicit owner evidence',
  learning_regression:'Regression blocks promotion'
});
export class ContractDenial extends Error {
  constructor(code) {
    if(!Object.hasOwn(messages,code))throw new TypeError('Unknown application denial code');
    super(messages[code]);this.name='ContractDenial';
    Object.defineProperty(this,'code',{value:code,enumerable:true});
  }
}
