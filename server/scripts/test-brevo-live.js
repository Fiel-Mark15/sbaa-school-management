// One-shot operator diagnostic. No database import, account lookup, or real portal token.
// All inputs must be supplied privately as local environment variables.
const recipient=process.env.BREVO_TEST_TO?.trim();
const confirmation=process.env.BREVO_TEST_TO_CONFIRM?.trim();
const validEmail=value=>typeof value==='string' && value.length<=190 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && !value.toLowerCase().endsWith('.test');
if(process.env.MAIL_MODE!=='brevo' || process.env.MAIL_FROM!=='SBAA System <sbaa.chcci.admin@gmail.com>' || !process.env.BREVO_API_KEY?.trim()){
  console.error('Brevo diagnostic not sent: MAIL_MODE, MAIL_FROM, or BREVO_API_KEY is missing or invalid.');
  process.exitCode=1;
}else if(!validEmail(recipient) || recipient!==confirmation || process.env.BREVO_TEST_SEND_ONCE!=='YES'){
  console.error('Brevo diagnostic not sent: enter the same inbox you control twice and explicitly confirm the one-time send.');
  process.exitCode=1;
}else{
  const {sendBrevoDiagnosticMail,safeMailErrorCode}=await import('../utils/mail.js');
  try{
    const result=await sendBrevoDiagnosticMail(recipient);
    console.log(`Brevo accepted one diagnostic request (HTTP ${result.statusCode}; message ID present). Inbox receipt remains unverified.`);
  }catch(error){
    console.error(`Brevo did not confirm the diagnostic request (${safeMailErrorCode(error)}). Do not retry an unknown outcome before checking the inbox and Brevo logs.`);
    process.exitCode=1;
  }
}
