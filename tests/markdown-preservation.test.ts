import { describe, expect, it } from "vitest";
import { parseQuestionFile } from "../src/core/question-parser";
import { deleteCurrentManagedQuestion, replaceCurrentManagedQuestion } from "../src/core/managed-question";
import { registerQuestion, updateQuestionMetadata } from "../src/core/question-writer";

const path="MIA/수학/문제은행.md";
const parse=(content:string)=>parseQuestionFile(path,content).questions;
const metadata={questionType:"정의형" as const,coreKeywords:[],subKeywords:[]};
const source=`# 수학 문제은행

### 사용자 제목

<!-- 문제 앞 주석 -->
> [!question] 사용자 문제 표시
> 원래 질문
^mia-q-one

<!-- 앵커 뒤 주석 -->
> [!mia]- 내 학습 정보
> 유형: 정의형
> 핵심:
> 보조:
> 이어볼 질문: [[다른과목/문제은행#^mia-q-next|다음]]
> 생성: 2026-01-01T00:00:00Z
> 수정: 2026-01-02T00:00:00Z
> 나만의 메모: 원문을 보존
> <!-- 메타데이터 안 주석 -->

<!-- 답 앞 주석 -->
#### 정답

원래 정답

### 이웃 문제

> [!question] 문제
> 이웃 질문
^mia-q-two

#### 정답

이웃 정답
`;

describe("lossless managed Markdown boundaries",()=>{
  it.each(["\n","\r\n"])("preserves unknown fields, comments and unmodified raw content with newline %j",newline=>{
    const text=source.replaceAll("\n",newline),original=parse(text)[0]!;
    const result=replaceCurrentManagedQuestion(text,original,parse,{...metadata,questionMarkdown:original.questionMarkdown,answerMarkdown:"수정한 정답"});
    for(const line of ["<!-- 문제 앞 주석 -->","<!-- 앵커 뒤 주석 -->","<!-- 답 앞 주석 -->","> 나만의 메모: 원문을 보존","> <!-- 메타데이터 안 주석 -->","> [!mia]- 내 학습 정보","> [!question] 사용자 문제 표시"]){expect(result).toContain(line);}
    expect(result.slice(result.indexOf("### 이웃 문제"))).toBe(text.slice(text.indexOf("### 이웃 문제")));
    expect(result).toContain("> 이어볼 질문: [[다른과목/문제은행#^mia-q-next|다음]]");
    expect(parse(result)[0]!.answerMarkdown).toBe("수정한 정답");
    if(newline==="\r\n")expect(result.replaceAll("\r\n","")).not.toContain("\n");
  });
  it("keeps omitted optional metadata and unknown fields during a metadata-only update",()=>{
    const original=parse(source)[0]!;const result=updateQuestionMetadata(source,original,{...metadata,questionType:"원리형"});
    for(const line of ["> 나만의 메모: 원문을 보존","> 생성: 2026-01-01T00:00:00Z","> 수정: 2026-01-02T00:00:00Z","> 이어볼 질문: [[다른과목/문제은행#^mia-q-next|다음]]"]){expect(result).toContain(line);}
    expect(parse(result)[0]!.questionType).toBe("원리형");
  });
  it("allows explicit connection removal without erasing unrelated custom fields",()=>{
    const result=updateQuestionMetadata(source,parse(source)[0]!,{...metadata,followUpLinks:[]});
    expect(result).not.toContain("> 이어볼 질문:");expect(result).toContain("> 나만의 메모: 원문을 보존");
  });
  it("reuses a preexisting metadata block when registering an unregistered question",()=>{
    const text=source.replace("^mia-q-one\n","");const result=registerQuestion(text,parse(text)[0]!,metadata,"mia-q-registered");
    expect(result.match(/\[!mia\]/g)).toHaveLength(1);expect(result).toContain("> 나만의 메모: 원문을 보존");
    expect(parse(result)[0]!.id).toBe("mia-q-registered");
  });
  it.each(["edit","delete"])("refuses a stale %s if another device changed the target answer",action=>{
    const original=parse(source)[0]!,changed=source.replace("원래 정답","다른 기기에서 고친 정답");
    expect(()=>action==="edit"?replaceCurrentManagedQuestion(changed,original,parse,{...metadata,questionMarkdown:"질문",answerMarkdown:"내 정답"}):deleteCurrentManagedQuestion(changed,original,parse)).toThrow(/바뀌|변경/);
  });
  it("relocates an unchanged question after unrelated lines were inserted",()=>{
    const original=parse(source)[0]!;const result=replaceCurrentManagedQuestion("서문\n\n"+source,original,parse,{...metadata,questionMarkdown:original.questionMarkdown,answerMarkdown:"수정 정답"});
    expect(result.startsWith("서문\n\n")).toBe(true);expect(result).toContain("> 나만의 메모: 원문을 보존");
  });
});
