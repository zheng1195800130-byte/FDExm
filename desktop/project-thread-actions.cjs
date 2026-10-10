'use strict';

const codex = require('../src/core/codex.cjs');
const { listProjectThreads } = require('../src/core/project-threads.cjs');

function createProjectThreadActions({ store, reader = codex }) {
  const project = id => {
    const found = store.getState().projects.find(item => item.id === id);
    if (!found) throw new Error('项目不存在，请重新选择');
    return found;
  };
  return {
    list(id) { return listProjectThreads({ cwd: project(id).devDir, reader }); },
    async bind(id, { threadId = '', adoptCwd = false } = {}) {
      const current = project(id);
      if (typeof threadId !== 'string' || threadId.length > 1000 || typeof adoptCwd !== 'boolean') throw new Error('Codex 关联无效，请重新选择');
      if (!threadId) {
        if (adoptCwd) throw new Error('请先选择要关联的会话');
        return store.bindCodexThread(id, { threadId: '' });
      }
      // Re-read the metadata at submission time. The renderer supplies only an
      // ID and explicit consent; it cannot choose an arbitrary filesystem cwd.
      const result = await listProjectThreads({ cwd: current.devDir, reader });
      if (adoptCwd) {
        const candidate = result.candidates.find(thread => thread.id === threadId);
        if (!candidate) throw new Error('推荐会话已变化，请刷新列表后重新选择');
        // Before changing any project data, verify the candidate remains an
        // exact member of the directory that will be used by the strict reader.
        const exact = await reader.listThreads({ cwd: candidate.cwd });
        if (!exact.some(thread => thread.id === threadId)) throw new Error('会话目录已变化，请刷新列表后重新选择');
        return store.bindCodexThread(id, { threadId, devDir: candidate.cwd });
      }
      if (!result.threads.some(thread => thread.id === threadId)) throw new Error('会话不属于该开发目录，请刷新列表后选择');
      return store.bindCodexThread(id, { threadId });
    },
  };
}

module.exports = { createProjectThreadActions };
