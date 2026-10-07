import {authorized} from './config.js';
// Telegram transport fields only; mixed quotes conservatively label the whole message.
// Arbitrary pasted quote semantics are not parsed.
export function knownQuote(message) {
  return message?.quote!==undefined || [message?.entities,message?.caption_entities].some(entities=>
    Array.isArray(entities)&&entities.some(entity=>['blockquote','expandable_blockquote'].includes(entity?.type)));
}
// Version 1 is written only by quote-aware host intake. Older origins are audit,
// not proof of an original owner statement; a quote flag always overrides them.
export function trustedHistoryOrigin(provenance) {
  if(provenance?.known_quote)return 'quoted';
  const origin=provenance?.origin;
  if(['direct_owner','owner_group'].includes(origin)&&provenance.provenance_version!==1)return 'legacy_unknown';
  return origin||'legacy_unknown';
}
const attachmentFields=['document','photo','voice','audio','video','video_note','animation','sticker','contact','location'];
// Host transport metadata, shared with action approval. Text never grants authority.
export function directOwner(message,cfg) {
  return !cfg.group && String(message?.from?.id)===cfg.owner && authorized(message,cfg) &&
    !['forward_origin','forward_from','forward_from_chat','forward_date','forward_sender_name'].some(field=>message[field]!==undefined) &&
    !message.is_automatic_forward && !message.via_bot && !message.event && !knownQuote(message) &&
    !attachmentFields.some(field=>message[field]!==undefined);
}
export function historyOrigin(message,cfg) {
  if(message.event)return 'event';
  if(['forward_origin','forward_from','forward_from_chat','forward_date','forward_sender_name'].some(field=>message[field]!==undefined)||message.is_automatic_forward)return 'forwarded';
  if(message.via_bot||message.from?.is_bot)return 'bot';
  if(attachmentFields.some(field=>message[field]!==undefined))return 'attachment';
  if(knownQuote(message))return 'other';
  if(cfg.group?.state==='active'&&String(message.chat?.id)===cfg.group.chat_id&&String(message.from?.id)===cfg.owner&&!message.from?.is_bot)return 'owner_group';
  return directOwner(message,cfg)?'direct_owner':'other';
}
