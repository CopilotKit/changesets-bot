// @ts-ignore
import humanId from "human-id";
import { Probot, Context } from "probot";
import { EmitterWebhookEvent } from "@octokit/webhooks";
import { getChangedPackages } from "./get-changed-packages";
import {
  ReleasePlan,
  ComprehensiveRelease,
  VersionType,
} from "@changesets/types";
import markdownTable from "markdown-table";
import { captureException } from "@sentry/node";
import { ValidationError } from "@changesets/errors";

const getReleasePlanMessage = (releasePlan: ReleasePlan | null) => {
  if (!releasePlan) return "";

  const publishableReleases = releasePlan.releases.filter(
    (x): x is ComprehensiveRelease & { type: Exclude<VersionType, "none"> } =>
      x.type !== "none"
  );

  let table = markdownTable([
    ["Name", "Type"],
    ...publishableReleases.map((x) => {
      return [
        x.name,
        {
          major: "Major",
          minor: "Minor",
          patch: "Patch",
        }[x.type],
      ];
    }),
  ]);

  return `<details><summary>This PR includes ${
    releasePlan.changesets.length
      ? `changesets to release ${
          publishableReleases.length === 1
            ? "1 package"
            : `${publishableReleases.length} packages`
        }`
      : "no changesets"
  }</summary>

  ${
    publishableReleases.length
      ? table
      : "When changesets are added to this PR, you'll see the packages that this PR includes changesets for and the associated semver types"
  }

</details>`;
};

const getAbsentMessage = (
  commitSha: string,
  addChangesetUrl: string,
  releasePlan: ReleasePlan | null
) => `###  ⚠️  No Changeset found

Latest commit: ${commitSha}

Merging this PR will not cause a version bump for any packages. If these changes should not result in a new version, you're good to go. **If these changes should result in a version bump, you need to add a changeset.**

${getReleasePlanMessage(releasePlan)}

[Click here if you're a maintainer who wants to add a changeset to this PR](${addChangesetUrl})

`;

const getIrrelevantMessage = (
  commitSha: string,
  addChangesetUrl: string,
  releasePlan: ReleasePlan | null
) => `### ⏭️ Changeset Not Required

Latest commit: ${commitSha}

No changes in this PR affected the \`@copilitkit/*\` packages. Merging this PR will not cause a version bump for any packages.

Changeset is not required for this PR.
`;

const getApproveMessage = (
  commitSha: string,
  addChangesetUrl: string,
  releasePlan: ReleasePlan | null
) => `###  🦋  Changeset detected

Latest commit: ${commitSha}

**The changes in this PR will be included in the next version bump.**

${getReleasePlanMessage(releasePlan)}

[Click here if you're a maintainer who wants to add another changeset to this PR](${addChangesetUrl})

`;

const getNewChangesetTemplate = (changedPackages: string[], title: string) =>
  encodeURIComponent(`---
${changedPackages.map((x) => `"${x}": patch`).join("\n")}
---

${title}
`);

type PRContext = EmitterWebhookEvent<
  "pull_request.opened" | "pull_request.synchronize"
> &
  Omit<Context, keyof EmitterWebhookEvent>;

const getCommentId = (
  context: PRContext,
  params: { repo: string; owner: string; issue_number: number }
) =>
  context.octokit.issues.listComments(params).then((comments) => {
    const changesetBotComment = comments.data.find(
      // TODO: find what the current user is in some way or something
      (comment) => {
        return comment.user?.login === "changesets-bot-copilotkit[bot]";
      }
    );
    return changesetBotComment ? changesetBotComment.id : null;
  });

const hasChangesetBeenAdded = (
  changedFilesPromise: ReturnType<PRContext["octokit"]["pulls"]["listFiles"]>
) =>
  changedFilesPromise.then((files) =>
    files.data.some(
      (file) =>
        file.status === "added" &&
        /^CopilotKit\/\.changeset\/.+\.md$/.test(file.filename) &&
        file.filename !== "CopilotKit/.changeset/README.md"
    )
  );

// Add type for push context
type PushContext = EmitterWebhookEvent<"push"> &
  Omit<Context, keyof EmitterWebhookEvent>;

export default (app: Probot) => {
  app.auth();
  app.log("Yay, the app was loaded!");

  const handlePRUpdate = async (
    context: PRContext | PushContext,
    prNumber: number,
    headSha: string,
    headRef: string,
    repo: { repo: string; owner: string }
  ) => {
    let errFromFetchingChangedFiles = "";

    try {
      let changedFilesPromise = context.octokit.pulls.listFiles({
        ...repo,
        pull_number: prNumber,
      });

      const [
        commentId,
        hasChangeset,
        { changedPackages, releasePlan, anyRelevantChanges },
      ] = await Promise.all([
        getCommentId(context as PRContext, { ...repo, issue_number: prNumber }),
        hasChangesetBeenAdded(changedFilesPromise),
        getChangedPackages({
          repo: repo.repo,
          owner: repo.owner,
          ref: headRef,
          changedFiles: changedFilesPromise.then((x) =>
            x.data.map((x) => x.filename)
          ),
          octokit: context.octokit,
          installationToken: (
            await (
              await app.auth()
            ).apps.createInstallationAccessToken({
              installation_id: context.payload.installation!.id,
            })
          ).data.token,
        }).catch((err) => {
          if (err instanceof ValidationError) {
            errFromFetchingChangedFiles = `<details><summary>💥 An error occurred when fetching the changed packages and changesets in this PR</summary>\n\n\`\`\`\n${err.message}\n\`\`\`\n\n</details>\n`;
          } else {
            console.error(err);
            captureException(err);
          }
          return {
            changedPackages: ["@fake-scope/fake-pkg"],
            releasePlan: null,
            anyRelevantChanges: false,
          };
        }),
      ] as const);

      if (!anyRelevantChanges) {
      }

      // Get commits between PR head and base
      const commits = await context.octokit.pulls.listCommits({
        ...repo,
        pull_number: prNumber,
      });

      const commitMessages = commits.data.map((commit) => `- ${commit.commit.message}`);

      let addChangesetUrl = `${
        context.payload.repository.html_url
      }/new/${headRef}?filename=CopilotKit/.changeset/${humanId({
        separator: "-",
        capitalize: false,
      })}.md&value=${getNewChangesetTemplate(
        changedPackages,
        commitMessages.join("\n"),
      )}`;

      let prComment = {
        ...repo,
        issue_number: prNumber,
        body: !anyRelevantChanges
          ? getIrrelevantMessage(headSha, addChangesetUrl, releasePlan)
          : (hasChangeset
              ? getApproveMessage(headSha, addChangesetUrl, releasePlan)
              : getAbsentMessage(headSha, addChangesetUrl, releasePlan)) +
            errFromFetchingChangedFiles,
      };

      if (commentId != null) {
        await context.octokit.issues.deleteComment({ ...prComment, comment_id: commentId });
      }
      return context.octokit.issues.createComment(prComment);
    } catch (err) {
      console.error(err);
      throw err;
    }
  };

  // Existing PR handler
  app.on(
    ["pull_request.opened", "pull_request.synchronize"],
    async (context) => {
      if (
        context.payload.pull_request.head.ref.startsWith("changeset-release")
      ) {
        return;
      }

      await handlePRUpdate(
        context,
        context.payload.number,
        context.payload.pull_request.head.sha,
        context.payload.pull_request.head.ref,
        {
          repo: context.payload.repository.name,
          owner: context.payload.repository.owner.login,
        }
      );
    }
  );
};
