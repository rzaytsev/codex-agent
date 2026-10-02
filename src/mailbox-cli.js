// Runs only inside the mailbox container, reached through the operator's SSH.
import fs from 'node:fs';
import { mailboxRequest } from './mailbox.js';
try {
  process.stdin.setEncoding('utf8');let body='';for await(const chunk of process.stdin){body+=chunk;if(body.length>100000)throw new Error();}
  const config=JSON.parse(fs.readFileSync('/run/mailbox/config.json','utf8'));
  const {operation,args}=JSON.parse(body);
  // SSH administration is already trusted; the request body cannot select a sender.
  const token=config.identities[config.sshIdentity]?.token;if(!token)throw new Error();
  console.log(JSON.stringify(await mailboxRequest('http://127.0.0.1:8766',token,operation,args)));
} catch(e) {console.error(JSON.stringify({error:'Mailbox call failed; retry mutations with the same message ID',code:e.code||null}));process.exitCode=1;}
