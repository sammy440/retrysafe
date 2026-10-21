import { Octokit } from "@octokit/rest";
import { eventKey, withGuardRoute } from "@retrysafe/guard";
import { leaseGuard } from "../../../../src/guard";

const octokit = new Octokit();

// GOOD: fetch-style adapter.
export const POST = withGuardRoute(leaseGuard, (req) => eventKey.github(req.headers), async (req) => {
  const payload = await req.json();
  await octokit.issues.createComment({ owner: "o", repo: "r", issue_number: payload.issue.number, body: "Thanks!" });
  return Response.json({ ok: true });
});
