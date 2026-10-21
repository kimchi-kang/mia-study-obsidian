import {describe,expect,it} from 'vitest';
import JSZip from 'jszip';
import {exportSubjectDocx} from '../src/core/subject-export';
import {renderManagedQuestion} from '../src/core/managed-question';
import {parseQuestionFile} from '../src/core/question-parser';

function bank(subject,count,images=false){
 return parseQuestionFile(`MIA/${subject}/bank.md`,Array.from({length:count},(_,i)=>renderManagedQuestion({
  questionMarkdown:`PROMPT_${subject}_${i}_END`,answerMarkdown:`ANSWER_${subject}_${i}_END${images?'\n\n![[missing.png]]':''}`,
  questionType:'정의형',coreKeywords:[],subKeywords:[],
 },`mia-q-${subject}-${i}`)).join('\n\n'),{subject}).questions;
}
async function xml(result){const zip=await JSZip.loadAsync(result.data,{checkCRC32:true});return zip.file('word/document.xml').async('string');}

describe('large export responsiveness and isolation',()=>{
 it('allows queued input before rendering and between batches without dropping or reordering content',async()=>{
  const questions=bank('math',256,true),snapshot=JSON.stringify(questions);
  let reads=0,initialReads,betweenReads;
  const input=new Promise(resolve=>setTimeout(()=>{initialReads=reads;resolve();},0));
  let between;
  const result=await exportSubjectDocx('math',questions,async()=>{
   reads++;
   // Simulate synchronous image decoding work whose resolved promise cannot service input.
   const started = performance.now();
   while (performance.now() - started < 2) { /* CPU work at the image boundary */ }
   if(reads===1)between=new Promise(resolve=>setTimeout(()=>{betweenReads=reads;resolve();},0));
   return null;
  });
  await input;await between;
  expect(initialReads).toBe(0);expect(betweenReads).toBeGreaterThan(0);expect(betweenReads).toBeLessThan(256);
  expect(reads).toBe(256);expect(result.count).toBe(256);expect(result.warnings).toHaveLength(1);
  expect(JSON.stringify(questions)).toBe(snapshot);
  const text=await xml(result);let prior=-1;
  for(let i=0;i<256;i++){
   const prompt=`PROMPT_math_${i}_END`,answer=`ANSWER_math_${i}_END`;
   expect(text.split(prompt)).toHaveLength(2);expect(text.split(answer)).toHaveLength(2);
   expect(text.indexOf(prompt)).toBeGreaterThan(prior);expect(text.indexOf(answer)).toBeGreaterThan(text.indexOf(prompt));prior=text.indexOf(answer);
  }
 });
 it('propagates an image failure after yielding and allows a fresh export without mutating the inputs',async()=>{
  const questions=bank('science',257,true),snapshot=JSON.stringify(questions),failure=Error('attachment unavailable');let reads=0;
  await expect(exportSubjectDocx('science',questions,async()=>{if(++reads===129)throw failure;return null;})).rejects.toBe(failure);
  expect(reads).toBe(129);expect(JSON.stringify(questions)).toBe(snapshot);
  const recovered=await exportSubjectDocx('science',questions,async()=>null);
  expect(recovered.count).toBe(257);expect(await xml(recovered)).toContain('ANSWER_science_256_END');
 });
 it('keeps interleaved exports separate across scheduled batches',async()=>{
  const a=bank('alpha',257),b=bank('beta',257);
  const [first,second]=await Promise.all([exportSubjectDocx('alpha',[...a,...b]),exportSubjectDocx('beta',[...a,...b])]);
  expect(first.count).toBe(257);expect(second.count).toBe(257);
  const [ax,bx]=await Promise.all([xml(first),xml(second)]);
  expect(ax).toContain('ANSWER_alpha_256_END');expect(ax).not.toContain('PROMPT_beta_');
  expect(bx).toContain('ANSWER_beta_256_END');expect(bx).not.toContain('PROMPT_alpha_');
 });
});
