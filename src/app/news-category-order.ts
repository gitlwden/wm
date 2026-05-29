const PRIORITY_CATEGORIES = ['security'] as const;

export interface NewsCategoryLoadEntry<TFeeds> {
  key: string;
  feeds: TFeeds;
}

export function orderNewsCategoriesForLoad<TFeeds>(
  categories: Array<NewsCategoryLoadEntry<TFeeds>>,
): Array<NewsCategoryLoadEntry<TFeeds>> {
  const priority = new Map<string, number>(
    PRIORITY_CATEGORIES.map((key, index) => [key, index]),
  );

  return categories
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const aPriority = priority.get(a.entry.key);
      const bPriority = priority.get(b.entry.key);
      if (aPriority != null && bPriority != null) return aPriority - bPriority;
      if (aPriority != null) return -1;
      if (bPriority != null) return 1;
      return a.index - b.index;
    })
    .map(({ entry }) => entry);
}
