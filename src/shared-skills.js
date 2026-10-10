// Reviewed source inventory for current owned container mounts. Laptop-only
// agent-messaging remains optional and grants no container/SSH capability.
export const sharedSkills=Object.freeze([
  'learn','scrape','skillify','investigate','planning','telegram-read','project-manager','google-maps','deep-research'
].map(name=>Object.freeze({name,source:`shared-skill/${name}/SKILL.md`,nativePath:`.agents/skills/${name}/SKILL.md`,readOnly:true})));
export function skillDiscoveryStatus(discovered,workspace) {
  return sharedSkills.map(({name,nativePath})=>({name,enabled:discovered.some(skill=>skill.name===name&&skill.enabled===true&&skill.path===`${workspace}/${nativePath}`)}));
}
