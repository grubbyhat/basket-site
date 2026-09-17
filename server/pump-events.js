import bs58 from 'bs58';
import { PUMP_SDK, PUMP_FEE_PROGRAM_ID, PUMP_PROGRAM_ID } from '@pump-fun/pump-sdk';
import { accountKeys } from './settlement.js';

// Decode event CPIs from the fee program, not arbitrary log text.
export function feeEvents(details) {
  const keys = accountKeys(details);
  const events = [];
  for (const group of details.meta.innerInstructions || []) {
    for (const ix of group.instructions) {
      const program = keys[ix.programIdIndex]?.equals(PUMP_FEE_PROGRAM_ID) ? PUMP_SDK.offlinePumpFeeProgram
        : keys[ix.programIdIndex]?.equals(PUMP_PROGRAM_ID) ? PUMP_SDK.offlinePumpProgram : null;
      if (!program) continue;
      const data = typeof ix.data === 'string' ? Buffer.from(bs58.decode(ix.data)) : Buffer.from(ix.data);
      if (!data.subarray(0, 8).equals(Buffer.from([228, 69, 165, 46, 81, 203, 154, 29]))) continue;
      const event = program.coder.events.decode(data.subarray(8).toString('base64'));
      if (event) events.push(event);
    }
  }
  return events;
}
