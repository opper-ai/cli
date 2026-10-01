import {it,expect,vi} from 'vitest';
import {withLoginRecovery} from '../../src/auth/launch-recovery.js';
it('reapproves rejected saved login once before starting the agent',async()=>{
 const launch=vi.fn().mockRejectedValueOnce({status:401}).mockResolvedValue(0),auth=vi.fn();
 expect(await withLoginRecovery(launch,auth,true)).toBe(0);expect(auth).toHaveBeenCalledOnce();expect(launch).toHaveBeenCalledTimes(2);
});
it('does not retry forbidden, network, or repeated authentication failures',async()=>{
 for(const error of [{status:403},new Error('network')]){const auth=vi.fn();await expect(withLoginRecovery(()=>Promise.reject(error),auth,true)).rejects.toBe(error);expect(auth).not.toHaveBeenCalled();}
 const error={status:401},auth=vi.fn(),launch=vi.fn().mockRejectedValue(error);
 await expect(withLoginRecovery(launch,auth,true)).rejects.toBe(error);expect(launch).toHaveBeenCalledTimes(2);expect(auth).toHaveBeenCalledOnce();
});
it('noninteractive use gives the real CLI recovery command without launching a browser',async()=>{
 const auth=vi.fn();await expect(withLoginRecovery(()=>Promise.reject({status:401}),auth,false)).rejects.toMatchObject({code:'AUTH_REQUIRED',hint:expect.stringContaining('opper login --force')});expect(auth).not.toHaveBeenCalled();
});
