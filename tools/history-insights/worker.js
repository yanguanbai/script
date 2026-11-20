import { analyze, loadHistory, mergeHistories } from './analytics.mjs';

let records = [];

self.onmessage = async event => {
  const { type, file, text, filename, files, start, end, requestId } = event.data || {};
  try {
    if (type === 'load') {
      // 支持一次读多个备份：逐个解析后在主线程之外合并，同一视频的快照取并集、次数取最大。
      const list = Array.isArray(files) && files.length
        ? files
        : file || text ? [{ file, text, name: filename || file?.name || '' }] : [];
      if (!list.length) throw new Error('请先选择有效的历史记录文件。');

      const totalBytes = list.reduce((sum, item) => sum + (item.file?.size || 0), 0);
      let doneBytes = 0;
      const parts = [];

      for (const item of list) {
        self.postMessage({
          type: 'progress',
          requestId,
          message: list.length > 1 ? `正在读取第 ${parts.length + 1} / ${list.length} 个备份…` : '正在本地读取文件…',
          value: 2 + Math.round((doneBytes / Math.max(totalBytes, 1)) * 10)
        });
        const source = item.file ? await item.file.text() : item.text;
        if (!source) throw new Error(`${item.name || '文件'} 读不出内容。`);
        const offset = doneBytes;
        const part = loadHistory(source, item.name || '', (done, total) => {
          const value = list.length > 1
            ? 12 + Math.round(((offset + (done / Math.max(total, 1)) * (item.file?.size || 0)) / Math.max(totalBytes, 1)) * 78)
            : 8 + Math.round((done / Math.max(total, 1)) * 82);
          self.postMessage({ type: 'progress', requestId, message: `正在整理记录 ${done.toLocaleString()} / ${total.toLocaleString()}…`, value });
        });
        parts.push(part);
        doneBytes += item.file?.size || 0;
      }

      self.postMessage({ type: 'progress', requestId, message: '正在合并并去重…', value: 92 });
      const merged = mergeHistories(parts);
      records = merged.records;
      self.postMessage({
        type: 'loaded',
        requestId,
        recordCount: records.length,
        files: parts.length,
        duplicates: merged.duplicates,
        range: merged.range
      });
    } else if (type === 'analyze') {
      if (!records.length) throw new Error('请先选择有效的历史记录文件。');
      self.postMessage({ type: 'progress', requestId, message: '正在按所选时间范围生成统计…', value: 0 });
      const result = analyze(records, start, end);
      self.postMessage({ type: 'analysis', requestId, result });
    }
  } catch (error) {
    self.postMessage({ type: 'error', requestId, message: error?.message || '分析失败。' });
  }
};
