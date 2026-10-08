export function isDraftSkillVersion(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return !normalized || normalized === "draft";
}

export function mvpSkillVersionFromDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const year = safeDate.getUTCFullYear();
  const month = String(safeDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(safeDate.getUTCDate()).padStart(2, "0");
  return `mvp-${year}.${month}.${day}-01`;
}

export function resolveMvpSkillVersion({
  versionIntent = "",
  targetVersion = "",
  publishedAt = "",
} = {}) {
  const intendedVersion = String(versionIntent || "").trim();
  if (!isDraftSkillVersion(intendedVersion)) return intendedVersion;
  const requestedVersion = String(targetVersion || "").trim();
  if (!isDraftSkillVersion(requestedVersion)) return requestedVersion;
  return mvpSkillVersionFromDate(publishedAt);
}

export function selectSkillPublicationHead({
  publications = [],
  resolveDraft = () => null,
  baselineVersion = "",
} = {}) {
  const orderedPublications = [...publications]
    .filter((publication) => publication && publication.status === "mvp_skill_published")
    .sort((left, right) => {
      const byTime = String(left.publishedAt || "").localeCompare(String(right.publishedAt || ""));
      return byTime || String(left.publicationId || "").localeCompare(String(right.publicationId || ""));
    });
  let head = null;
  let currentVersion = String(baselineVersion || "").trim();

  for (const publication of orderedPublications) {
    const draft = resolveDraft(publication);
    if (!draft) continue;
    const publishedVersion = String(publication.version || "").trim();
    const previousVersion = String(draft.previousVersion || "").trim();
    const targetIntent = String(draft.targetVersion || draft.versionIntent || publishedVersion).trim();
    const targetVersion = isDraftSkillVersion(targetIntent) ? publishedVersion : targetIntent;
    if (!publishedVersion || (targetVersion && targetVersion !== publishedVersion)) continue;

    if (!head && !currentVersion && !previousVersion) {
      head = { publication, draft };
      currentVersion = publishedVersion;
      continue;
    }
    if (publishedVersion === currentVersion) {
      head = { publication, draft };
      continue;
    }
    if (previousVersion && previousVersion === currentVersion) {
      head = { publication, draft };
      currentVersion = publishedVersion;
      continue;
    }
    // Older package-intake records may have reached human-approved publication
    // without copying the sidecar version into `previousVersion`. A later,
    // versioned package is still an auditable upgrade head; otherwise restart
    // reconciliation can silently restore the older catalog record.
    if (!previousVersion &&
      String(draft?.skillPackageIdentity?.version || "").trim() === publishedVersion &&
      isStrictlyNewerSkillVersion(publishedVersion, currentVersion) &&
      isLaterPublication(publication, head?.publication)) {
      head = { publication, draft };
      currentVersion = publishedVersion;
    }
  }

  return head;
}

function isStrictlyNewerSkillVersion(candidate = "", current = "") {
  const candidateParts = datedSkillVersion(candidate);
  const currentParts = datedSkillVersion(current);
  if (!candidateParts || !currentParts) return false;
  for (let index = 0; index < candidateParts.length; index += 1) {
    if (candidateParts[index] === currentParts[index]) continue;
    return candidateParts[index] > currentParts[index];
  }
  return false;
}

function datedSkillVersion(value = "") {
  const match = /^skill-(\d{4})\.(\d{2})\.(\d{2})-(\d+)$/.exec(String(value || "").trim());
  return match ? match.slice(1).map(Number) : null;
}

function isLaterPublication(candidate = {}, current = null) {
  if (!current) return true;
  const byTime = String(candidate.publishedAt || "").localeCompare(String(current.publishedAt || ""));
  return byTime > 0 || (byTime === 0 &&
    String(candidate.publicationId || "").localeCompare(String(current.publicationId || "")) > 0);
}
