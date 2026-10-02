import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const LOCATION_TTL_MS = 12 * 60 * 60 * 1000;
export const LOCATION_HEADING = '## Saved locations';

export class Locations {
  constructor(workspace) { this.root=path.join(workspace,'state','locations'); }
  file(user) {
    if(!/^\d+$/.test(user)) throw new Error('Invalid location owner');
    return path.join(this.root,`${user}.json`);
  }
  read(user) {
    try {return JSON.parse(fs.readFileSync(this.file(user),'utf8'));}
    catch(e) {if(e.code==='ENOENT') return {default:null,temporary:null};throw e;}
  }
  write(user,data) {
    fs.mkdirSync(this.root,{recursive:true,mode:0o700});
    const file=this.file(user),temp=file+'.'+randomUUID();
    try {fs.writeFileSync(temp,JSON.stringify(data,null,2)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(temp,file);}
    finally {try {fs.unlinkSync(temp);} catch(e) {if(e.code!=='ENOENT') throw e;}}
  }
  point(value) {
    const {latitude,longitude}=value || {};
    if(typeof latitude!=='number'||!Number.isFinite(latitude)||Math.abs(latitude)>90||typeof longitude!=='number'||!Number.isFinite(longitude)||Math.abs(longitude)>180) throw new Error('Invalid coordinates');
    return {latitude,longitude};
  }
  receive(user,message,now=Date.now(),updateId) {
    const point=this.point(message.location);
    const captured=(message.edit_date ?? message.date)*1000;
    if(!Number.isFinite(captured)||captured<=0||captured>now+300000) throw new Error('Invalid location timestamp');
    const data=this.read(user);
    const previous=Date.parse(data.temporary?.updated_at || '');
    if(previous>captured || (previous===captured && (Number(data.temporary.message_id)>message.message_id || (Number(data.temporary.message_id)===message.message_id && (updateId ?? -1)<=(data.temporary.update_id ?? -1))))) return false;
    data.temporary={...point,updated_at:new Date(Math.min(captured,now)).toISOString(),received_at:new Date(now).toISOString(),message_id:message.message_id,...(updateId!==undefined?{update_id:updateId}:{}),source:'telegram'};
    const accuracy=message.location.horizontal_accuracy;
    if(typeof accuracy==='number'&&Number.isFinite(accuracy)&&accuracy>=0&&accuracy<=1500) data.temporary.horizontal_accuracy=accuracy;
    this.write(user,data);return true;
  }
  get(user,now=Date.now()) {
    const data=this.read(user),updated=Date.parse(data.temporary?.updated_at || '');
    const fresh=Number.isFinite(updated)&&updated<=now&&now-updated<LOCATION_TTL_MS;
    return {file:this.file(user),source:fresh?'temporary':data.default?'default':null,location:fresh?data.temporary:data.default,temporary_expires_at:Number.isFinite(updated)?new Date(updated+LOCATION_TTL_MS).toISOString():null};
  }
  setDefault(user,value,now=Date.now()) {
    const point=this.point(value);
    if(value.label!==undefined&&(typeof value.label!=='string'||value.label.length>200)) throw new Error('Invalid location label');
    const data=this.read(user);
    data.default={...point,...(value.label?{label:value.label}:{}),updated_at:new Date(now).toISOString(),source:'user'};
    this.write(user,data);return {updated:'default',file:this.file(user)};
  }
  promote(user,now=Date.now()) {
    const selected=this.get(user,now);
    if(selected.source!=='temporary') return false;
    this.setDefault(user,selected.location,now);return true;
  }
  clear(user) {const data=this.read(user);data.temporary=null;this.write(user,data);return {cleared:'temporary'};}
}
