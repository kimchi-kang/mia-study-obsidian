import {describe,expect,it}from 'vitest';
import {exportSubjectDocx}from '../src/core/subject-export';
import {renderManagedQuestion}from '../src/core/managed-question';
import {parseQuestionFile}from '../src/core/question-parser';
const png=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII=','base64')).buffer;
const image={data:png,type:'png',width:1,height:1};
function bank(file,targets){return parseQuestionFile(file,targets.map((target,i)=>renderManagedQuestion({questionMarkdown:`PROMPT_${i}_END`,answerMarkdown:`ANSWER_${i}_END\n\n![[${target}]]`,questionType:'정의형',coreKeywords:[],subKeywords:[]},`mia-q-${i}`)).join('\n\n'),{subject:'math'}).questions;}

describe('small expensive export responsiveness',()=>{
 it('services queued input during a small document with expensive resolved image reads',async()=>{
  const questions=bank('MIA/math/a.md',['a.png','b.png','c.png','d.png']);let reads=0,atStart,between;let middle;
  const initial=new Promise(resolve=>setTimeout(()=>{atStart=reads;resolve();},0));
  await exportSubjectDocx('math',questions,async()=>{reads++;if(reads===1)middle=new Promise(resolve=>setTimeout(()=>{between=reads;resolve();},0));const at=performance.now();while(performance.now()-at<20){}return image;});
  await initial;await middle;expect(atStart).toBe(0);expect(between).toBeLessThan(4);expect(reads).toBe(4);
 });
});
