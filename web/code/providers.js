// FileProvider { list(path), read(path), write(path, content), mkdir(path) }
// AIProvider   { chat({messages, model, skill}) /* async generator, yields chunks */, listSkills(), listModels() }

const MOCK_FILES = {
  '/project':                    { type: 'dir' },
  '/project/README.md':          { type: 'file', content: '# Demo Project\n\nMock file tree for the Atlantis code editor frontend pass. Nothing here touches a real filesystem yet.\n' },
  '/project/package.json':       { type: 'file', content: '{\n  "name": "demo-project",\n  "version": "1.0.0"\n}\n' },
  '/project/src':                { type: 'dir' },
  '/project/src/index.js':       { type: 'file', content: "export function greet(name) {\n  return `Hello, ${name}!`;\n}\n" },
  '/project/src/utils.js':       { type: 'file', content: "export function sum(a, b) {\n  return a + b;\n}\n\nexport function average(nums) {\n  let total = 0;\n  for (let i = 0; i <= nums.length; i++) {\n    total += nums[i];\n  }\n  return total / nums.length;\n}\n" },
  '/project/src/styles.css':     { type: 'file', content: ".button {\n  color: red;\n  padding: 8px;\n}\n" },
  '/project/src/app.py':         { type: 'file', content: "def main():\n    print('hello from the mock project')\n\nif __name__ == '__main__':\n    main()\n" },
};

export class MockFileProvider {
  constructor() {
    this.files = new Map(Object.entries(MOCK_FILES).map(([k, v]) => [k, { ...v }]));
  }

  async list(path) {
    const prefix = path.replace(/\/$/, '') + '/';
    const entries = [];
    for (const [p, entry] of this.files) {
      if (p === path) continue;
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest.includes('/')) continue;
      entries.push({ name: rest, type: entry.type, path: p });
    }
    return entries.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)));
  }

  async read(path) {
    const entry = this.files.get(path);
    if (!entry || entry.type !== 'file') throw new Error(`Not found: ${path}`);
    return entry.content;
  }

  async write(path, content) {
    const existed = this.files.has(path);
    this.files.set(path, { type: 'file', content });
    return { created: !existed };
  }

  async mkdir(path) {
    this.files.set(path, { type: 'dir' });
    return { created: true };
  }
}

const MOCK_SKILLS = [
  { id: 'explain',    name: 'Explain',    description: 'Explain the selected code in plain language.',        triggers: ['explain', 'what does', 'how does', 'walk me through'] },
  { id: 'refactor',   name: 'Refactor',   description: 'Suggest a cleaner version of the selected code.',      triggers: ['refactor', 'clean up', 'simplify', 'tidy'] },
  { id: 'add-tests',  name: 'Add Tests',  description: 'Generate tests for the selected code.',                triggers: ['test', 'tests', 'add tests', 'coverage'] },
  { id: 'fix-bug',    name: 'Fix Bug',    description: 'Diagnose and propose a fix for a bug.',                triggers: ['fix', 'bug', 'broken', 'error', 'crash'] },
];

const MOCK_MODELS = ['llama3.1:8b', 'qwen2.5-coder:7b', 'deepseek-coder:6.7b'];

const CANNED_RESPONSES = [
  "I looked at the open file — here's a quick summary of what it does, plus a couple of suggestions for improving readability.",
  "That function looks correct overall, but you could simplify the return statement and add a guard clause for empty input.",
  "Here's a proposed change: extract the repeated logic into a small helper and reuse it in both branches.",
];

const SKILL_RESPONSES = {
  'explain':    "This function takes an input, validates it, then returns a formatted result. The only subtlety is the early return near the top — everything after it assumes the input already passed validation.",
  'refactor':   "Here's a cleaner version: extract the repeated condition into a named boolean, and replace the nested if/else with a single guard clause at the top of the function.",
  'add-tests':  "Suggested test cases: empty input, a typical value, and a boundary value at the max length. Each should assert the return shape matches the documented contract.",
  'fix-bug':    "The bug is an off-by-one in the loop bound — it should be `< length`, not `<= length`. That's what's producing the trailing `undefined` entry.",
};

export class MockAIProvider {
  async listModels() {
    return MOCK_MODELS.slice();
  }

  async listSkills() {
    return MOCK_SKILLS.map(s => ({ ...s, triggers: s.triggers.slice() }));
  }

  async *chat({ messages, model, skill }) {
    const text = (skill && SKILL_RESPONSES[skill]) || CANNED_RESPONSES[Math.floor(Math.random() * CANNED_RESPONSES.length)];
    const words = text.split(' ');
    for (let i = 0; i < words.length; i++) {
      await new Promise(r => setTimeout(r, 35));
      yield words[i] + (i < words.length - 1 ? ' ' : '');
    }
  }
}

export class RealFileProvider {
  async list(path) {
    const r = await api('GET', `/api/fs?path=${encodeURIComponent(path || '')}`);
    if (r.error) throw new Error(r.error);
    return (r.entries || []).map(e => ({
      name: e.name,
      type: e.type,
      path: path ? `${path.replace(/\/$/, '')}/${e.name}` : e.name,
    }));
  }

  async read(path) {
    const r = await api('GET', `/api/fs/read?path=${encodeURIComponent(path)}`);
    if (r.error) throw new Error(r.error);
    return r.content ?? '';
  }

  async write(path, content) {
    const r = await api('POST', '/api/fs/write', { path, content });
    if (r.error) throw new Error(r.error);
    return { created: true };
  }

  async mkdir(path) {
    const r = await api('POST', '/api/fs/mkdir', { path });
    if (r.error) throw new Error(r.error);
    return { created: true };
  }
}

export class RealAIProvider {
  async listModels() {
    try {
      const res = await fetch(`${await resolveOllama()}/api/tags`);
      const data = await res.json();
      return (data.models || []).map(m => m.name);
    } catch (_) {
      return [];
    }
  }

  async listSkills() {
    return api('GET', '/api/skills');
  }

  async *chat({ messages, model, tools }) {
    const body = { model, messages, stream: true };
    if (tools?.length) body.tools = tools;
    const res = await fetch(`${await resolveOllama()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error; } catch (_) {}
      throw new Error(detail || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let toolCalls = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let chunk;
        try { chunk = JSON.parse(line); } catch (_) { continue; }
        if (chunk.message?.tool_calls?.length) toolCalls.push(...chunk.message.tool_calls);
        if (chunk.message?.content) yield chunk.message.content;
      }
    }
    if (toolCalls.length) yield { toolCalls };
  }
}
