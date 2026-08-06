export type HubPublishedVisibility = 'private' | 'shared' | 'public';

export interface MarketVisibilityInput {
  visibility: 'PUBLIC' | 'DEPARTMENT_SCOPED';
  publishedVisibility?: HubPublishedVisibility;
  allowPrivateLabel?: boolean;
}

export function marketVisibilityLabelKey(input: MarketVisibilityInput): 'skillhub.marketCard.visibilityPrivate' | 'skillhub.marketCard.visibilityPublic' | 'skillhub.marketCard.visibilityDept' {
  if (input.publishedVisibility === 'private' && input.allowPrivateLabel === true) {
    return 'skillhub.marketCard.visibilityPrivate';
  }
  if (input.publishedVisibility === 'public' || input.visibility === 'PUBLIC') return 'skillhub.marketCard.visibilityPublic';
  return 'skillhub.marketCard.visibilityDept';
}

export type MarketVisibilitySubtitleKey =
  | 'skillhub.marketDetail.visibilityPublic'
  | 'skillhub.marketDetail.visibilityPrivate'
  | 'skillhub.marketDetail.visibilityDept';

export function marketVisibilitySubtitleKey(input: MarketVisibilityInput): MarketVisibilitySubtitleKey {
  const key = marketVisibilityLabelKey(input);
  if (key.endsWith('visibilityPublic')) return 'skillhub.marketDetail.visibilityPublic';
  if (key.endsWith('visibilityPrivate')) return 'skillhub.marketDetail.visibilityPrivate';
  return 'skillhub.marketDetail.visibilityDept';
}
