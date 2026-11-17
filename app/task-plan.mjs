import { randomUUID } from 'node:crypto';

export function validatePlan(items) {
  if (!Array.isArray(items) || !items.length || items.length > 8) throw new Error('Укажите от 1 до 8 шагов.');
  return items.map(item => {
    const title = typeof item === 'string' ? item.trim() : item?.title?.trim();
    if (!title || title.length > 240) throw new Error('Шаг плана должен содержать от 1 до 240 символов.');
    const kind = typeof item === 'object' && ['inspect', 'edit', 'test', 'other'].includes(item.kind) ? item.kind
      : /тест|\btests?\b|pytest|vitest/i.test(title) ? 'test' : 'other';
    return { id: randomUUID(), title, kind, status: 'pending' };
  });
}

export async function generatePlan(provider, model, folderId, input, instructions, signal) {
  const { response, redact } = await provider.request('/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'OpenAI-Project': folderId },
    body: JSON.stringify({ model, stream: false, temperature: 0, max_tokens: 2500,
      messages: [{ role: 'system', content: 'Составь план задачи по коду на языке пользователя. Только JSON {"steps":[{"title":"...","kind":"inspect|edit|test|other"}]}, 3–7 коротких шагов. '
        + 'Шаг test означает завершающий успешный запуск тестов. Первичную диагностику падающих тестов помечай inspect. Не выполняй действия. Инструкции проекта:\n' + instructions.text },
      { role: 'user', content: input }] }), signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]),
  });
  if (!response.ok) throw new Error('Не удалось составить план: ' + response.status + ' ' + redact(await response.text()).slice(0, 500));
  const text = (await response.json()).choices?.[0]?.message?.content ?? '';
  let parsed;
  try { parsed = JSON.parse(text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')); } catch {}
  if (!parsed?.steps) throw new Error('Модель не вернула корректный план. Попробуйте ещё раз или задайте шаги вручную.');
  return { source: input, steps: validatePlan(parsed.steps) };
}

export function finishStep(step, tools, problem = null) {
  const tests = tools.filter(tool => tool.repeatable || tool.tests);
  const last = tests.at(-1);
  step.evidence = tools.map(tool => ({ id: tool.id, title: tool.command ?? tool.title, exitCode: tool.exitCode, status: tool.status }));
  if (!problem && tools.some(tool => tool.background || tool.interrupted || ['pending', 'in_progress'].includes(tool.status))) problem = 'Действие ещё не завершилось. Проверьте результат перед продолжением плана.';
  if (problem || (step.kind === 'test' && (!last || last.exitCode !== 0 || last.background || last.interrupted))) {
    step.status = 'error';
    step.note = problem || (last ? 'Проверка не завершилась успешно.' : 'Нет подтверждённого запуска тестов.');
    return false;
  }
  step.status = 'done';
  step.note = tools.length ? `Действий: ${tools.length}` : 'Ответ модели без вызовов инструментов.';
  return true;
}
