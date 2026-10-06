import {authorized} from './config.js';
// Host transport metadata, shared with action approval. Text never grants authority.
export function directOwner(message,cfg) {
  return !cfg.group && String(message?.from?.id)===cfg.owner && authorized(message,cfg) &&
    !['forward_origin','forward_from','forward_from_chat','forward_date','forward_sender_name'].some(field=>message[field]!==undefined) &&
    !message.is_automatic_forward && !message.via_bot && !message.event;
}
export function historyOrigin(message,cfg) {
  if(message.event)return 'event';
  if(['forward_origin','forward_from','forward_from_chat','forward_date','forward_sender_name'].some(field=>message[field]!==undefined)||message.is_automatic_forward)return 'forwarded';
  if(message.via_bot||message.from?.is_bot)return 'bot';
  if(['document','photo','voice','audio','video','video_note','animation','sticker','contact','location'].some(field=>message[field]!==undefined))return 'attachment';
  if(cfg.group?.state==='active'&&String(message.chat?.id)===cfg.group.chat_id&&String(message.from?.id)===cfg.owner&&!message.from?.is_bot)return 'owner_group';
  return directOwner(message,cfg)?'direct_owner':'other';
}
