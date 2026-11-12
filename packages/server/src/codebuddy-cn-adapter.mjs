import { randomUUID } from 'node:crypto'
import { streamCodeBuddy } from './codebuddy-cn-stream.mjs'

export const codeBuddyModel = {
  provider: 'codebuddy-cn', id: 'deepseek-v4.1-flash', name: 'CodeBuddy 国内站 Flash',
  inputModalities: ['text', 'image'], context: { contextWindow: 1_000_000 },
  reasoning: { defaultEffort: 'high', efforts: [
    {id:'low',name:'低'}, {id:'high',name:'高'}, {id:'max',name:'最高'}
  ] }
}

export function createCodeBuddyAdapter(LlmAdapter, attachments) {
  return new class extends LlmAdapter {
    providerInfo() { return {id:'codebuddy-cn',name:'CodeBuddy 国内站'} }
    async listModels() { return [codeBuddyModel] }
    async resolveModel() { return codeBuddyModel }
    imageRequestPricing() { return undefined }
    async *stream(options) {
      let nextIndex = 0
      let hasToolCalls = false
      for await (const event of streamCodeBuddy(options, attachments)) {
        if (event.type !== 'tool-call') {
          if (event.type === 'finish' && event.reason.kind === 'stop' && hasToolCalls) {
            yield {...event,reason:{kind:'tool-calls'}}
            continue
          }
          if (Number.isInteger(event.index)) nextIndex = Math.max(nextIndex,event.index+1)
          yield event
          continue
        }
        const index=nextIndex++
        hasToolCalls = true
        const id='call_dsh_'+randomUUID().replaceAll('-','')
        yield {type:'block-start',index,blockType:'tool-call'}
        yield {type:'tool-call-delta',index,id,name:event.name,argumentsDelta:event.arguments}
        yield {type:'block-end',index,block:{type:'tool-call',id,name:event.name,arguments:event.arguments}}
      }
    }
  }()
}
