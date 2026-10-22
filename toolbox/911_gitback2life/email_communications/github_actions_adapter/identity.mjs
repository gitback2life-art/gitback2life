import {SENDER} from './policy.mjs';
export async function verifySenderIdentity(accessToken,http=fetch){
  if(typeof accessToken!=='string'||!accessToken)throw Error('Google access token missing');
  const r=await http('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:`Bearer ${accessToken}`},signal:AbortSignal.timeout(20000)});
  if(!r.ok)throw Error('Cannot verify authorized Google sender');
  const account=await r.json();
  if(account.email!==SENDER||account.email_verified!==true)throw Error('Google account is not the verified authorized sender');
}
