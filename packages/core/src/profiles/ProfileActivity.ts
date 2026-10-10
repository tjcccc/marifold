import type { ProfileSummary } from '../config/ConfigSchema';
import type { ProfileActivitySummary } from '../sessions/SessionResolver';

/** Profiles with their session activity (pin, last update, preview), pinned
 * first, then most recently active, then by name. */
export function withProfileActivity(profiles: ProfileSummary[], activity: ProfileActivitySummary[]): ProfileSummary[] {
  const byProfile = new Map(activity.map(item => [item.profileName, item]));
  return profiles
    .map(profile => {
      const recent = byProfile.get(profile.name);
      return recent ? {
        ...profile,
        ...(recent.pinned ? { pinned: true } : {}),
        ...(recent.updatedAt ? { updatedAt: recent.updatedAt } : {}),
        ...(recent.preview ? { preview: recent.preview } : {}),
      } : profile;
    })
    .sort((a, b) => {
      const pinOrder = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
      if (pinOrder !== 0) { return pinOrder; }
      const activityOrder = (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
      return activityOrder !== 0 ? activityOrder : a.name.localeCompare(b.name);
    });
}
