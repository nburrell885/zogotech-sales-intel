// Strategic plan review, powered by the Anthropic API with web search.
//
// One school at a time so progress is visible and a failure on one does not
// take the batch down. The model is told to say plainly when it cannot find a
// plan: in a prospecting tool a confident invention is worse than a blank.

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

const SYSTEM = `You research community college strategic plans for a sales team at
ZogoTech, which sells student-success analytics and data warehousing to community colleges.

For the institution named, search the web for its current published strategic plan.
Read it. Then report only what the document actually says.

Rules that matter more than completeness:
- If you cannot find a published plan, say so and stop. Never infer priorities
  from a homepage, a news article, or a plan from a different institution.
- Every finding must carry a short direct quote and the source URL.
- Do not soften or embellish. If the plan says nothing about data, say that.

Score fit 0-5 on how strongly the plan signals a need for student-success
analytics: completion and retention goals, equity gaps, enrollment decline,
data culture, institutional research capacity, accreditation or grant pressure.

Return ONLY minified JSON, no markdown fence:
{"school":"","planFound":true,"planUrl":"","planPeriod":"","fit":0,
 "themes":[{"theme":"","quote":"","why":""}],
 "summary":"","angle":""}
"angle" is one sentence a rep could open a conversation with, grounded in the plan.`;

export async function reviewSchool(school) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
      messages: [{ role: 'user', content: `Institution: ${school}` }],
    }),
  });

  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();

  const text = (body.content || [])
    .filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

  const raw = text.replace(/^```(?:json)?/m, '').replace(/```$/m, '').trim();
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) {
    return { school, planFound: false, error: 'Model did not return JSON', raw: text.slice(0, 400) };
  }
  try {
    return { school, ...JSON.parse(raw.slice(start, end + 1)) };
  } catch (e) {
    return { school, planFound: false, error: 'Bad JSON from model', raw: raw.slice(0, 400) };
  }
}

// Runs a batch, writing progress after every school so the page can poll.
export async function reviewBatch(schools, onProgress) {
  const results = [];
  for (const school of schools) {
    let row;
    try {
      row = await reviewSchool(school);
    } catch (e) {
      row = { school, planFound: false, error: e.message };
    }
    row.reviewedAt = new Date().toISOString();
    results.push(row);
    if (onProgress) await onProgress(results, schools.length);
  }
  return results;
}
