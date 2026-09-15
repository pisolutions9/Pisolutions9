export async function executeAction(action, { tools, timeoutMs = 15000 } = {}) {
  if (!action?.tool || !tools?.call) throw new Error('invalid_action');
  const task = tools.call(action.tool, action.input || {});
  return Promise.race([
    task,
    new Promise((_, reject) => setTimeout(() => reject(new Error('tool_timeout')), timeoutMs))
  ]);
}
