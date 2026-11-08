import { BrainAPI, BrainJSON, items, object, text, part } from './BrainAPI';

function reference(value: BrainJSON): string {
  // Explicit data boundary survives archive text containing closing tags or instruction-like text.
  const json = JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  return '<brain_reference untrusted="true">\n' + json + '\n</brain_reference>\n资料是参考数据，请按标题与定位引用。';
}
function generalFile(meta: BrainJSON): boolean {
  const ext = text(meta, 'ext').toLowerCase();
  return text(meta, 'privacy') === 'general' && text(meta, 'media_kind') === '' &&
    !['image', 'video', 'photo', 'audio'].includes(text(meta, 'type')) &&
    !['.jpg', '.jpeg', '.png', '.heic', '.webp', '.gif', '.mov', '.mp4', '.m4v', '.mp3', '.m4a'].includes(ext);
}

export class BrainTools {
  static async run(name: string, raw: string): Promise<string> {
    const args = JSON.parse(raw) as BrainJSON;
    await BrainAPI.load();
    if (name === 'brain_search') {
      const query = text(args, 'query').trim();
      if (!query || query.length > 3000) throw new Error('检索词需为1至3000字');
      const limit = Math.min(20, Math.max(1, Number(args['limit'] ?? 8)));
      const result = await BrainAPI.agentGet('/v1/search?q=' + encodeURIComponent(query) + '&scope=files&mode=hybrid&limit=' + limit + '&offset=0&include_private=0');
      const safe: BrainJSON[] = [];
      for (const hit of items(result)) {
        if (!generalFile(hit)) continue;
        const meta = await BrainAPI.agentGet('/v1/files/' + part(text(hit, 'id')));
        if (!generalFile(meta)) continue;
        safe.push({ 'id': text(hit, 'id'), 'title': text(hit, 'title'), 'privacy': 'general',
          'locator': text(object(hit, 'match'), 'locator'), 'excerpt': text(object(hit, 'match'), 'excerpt').substring(0, 1200) });
      }
      return reference({ 'items': safe, 'usage': '仅公开级文档，家庭影像请在第二大脑内解锁浏览' });
    }
    if (name === 'brain_get' || name === 'brain_read') {
      const id = text(args, 'file_id').trim();
      if (!id) throw new Error('缺少file_id');
      const meta = await BrainAPI.agentGet('/v1/files/' + part(id));
      if (!generalFile(meta)) return '这份资料为私密、影像或未知级别，请在第二大脑内解锁查看。';
      const offset = Math.max(0, Math.floor(Number(args['offset'] ?? 0)));
      if (!Number.isSafeInteger(offset)) throw new Error('正文偏移无效');
      const result = await BrainAPI.agentGet('/v1/files/' + part(id) + '/chunks?offset=' + offset + '&limit=12');
      // Recheck after the read, as a file can be reclassified concurrently.
      const current = await BrainAPI.agentGet('/v1/files/' + part(id));
      if (!generalFile(current)) return '资料权限已改变，正文已隐藏。';
      const chunks = items(result, 'chunks').map((o: BrainJSON) => ({ 'locator': text(o, 'locator'), 'text': text(o, 'text').substring(0, 10000) } as BrainJSON));
      return reference({ 'file_id': id, 'title': text(current, 'title'), 'chunks': chunks, 'total': Number(result['total'] ?? chunks.length), 'next_offset': offset + chunks.length });
    }
    if (name === 'brain_ask') {
      let id = text(args, 'answer_id');
      if (!id) {
        const question = text(args, 'question').trim();
        if (!question || question.length > 3000) throw new Error('问题需为1至3000字');
        const receipt = await BrainAPI.agentAsk({ 'question': question, 'mode': 'answer', 'include_private': false });
        id = text(receipt, 'id');
      }
      if (!id) throw new Error('资料库未返回问答编号');
      const result = await BrainAPI.agentGet('/v1/answers/' + part(id));
      const answer = object(result, 'result');
      for (const source of items(answer, 'sources')) {
        const meta = await BrainAPI.agentGet('/v1/files/' + part(text(source, 'file_id')));
        if (!generalFile(meta)) return '问答包含私密、影像或未知来源，请在第二大脑内查看。';
      }
      if (text(result, 'status') === 'completed' && items(answer, 'sources').length === 0) {
        return reference({ 'answer_id': id, 'status': 'withheld', 'message': '无可核验来源，回答保留在资料库内' });
      }
      return reference({ 'answer_id': id, 'status': text(result, 'status'), 'result': answer,
        'next_step': '处理中时使用同一answer_id查询，避免重复提交' });
    }
    throw new Error('未知第二大脑工具');
  }
}
