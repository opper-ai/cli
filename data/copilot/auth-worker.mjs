// Isolate the shared SDK polling so cancelling a Copilot session also stops
// pending HTTP requests/timers. Credentials travel over private IPC, never stdout.
import {runDeviceFlow} from '../../dist/auth/device-flow.js';
process.once('message',async options=>{
 try{
  const slot=await runDeviceFlow({...options,onPrompt:prompt=>process.send?.({type:'prompt',prompt})});
  process.send?.({type:'result',slot},()=>process.exit(0));
 }catch(error){process.send?.({type:'error',message:error.message},()=>process.exit(1));}
});
process.on('disconnect',()=>process.exit(0));
