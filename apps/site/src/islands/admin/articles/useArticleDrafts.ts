import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getUser } from '../../../lib/session.ts';
import {
  getArticleDraft,
  listArticleDrafts,
  previewArticleDraft,
  writeArticleDraft,
} from './article-api.ts';

// Session identity prevents private data from being reused after an account change.
function scope() {
  return ['article-drafts', getUser()?.id] as const;
}
export function useArticleList(query: string) {
  return useInfiniteQuery({
    queryKey: [...scope(), 'list', query],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => listArticleDrafts(query, pageParam, signal),
    getNextPageParam: (page) => page.nextCursor,
    gcTime: 0,
    retry: false,
  });
}
export function useArticleDraft(articleId: string | null) {
  return useQuery({
    queryKey: [...scope(), 'detail', articleId],
    enabled: articleId !== null,
    queryFn: ({ signal }) => {
      if (!articleId) throw new Error('Article ID required');
      return getArticleDraft(articleId, signal);
    },
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}
export function useWriteArticle() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: writeArticleDraft,
    networkMode: 'always',
    retry: false,
    onSuccess: (draft) => {
      client.setQueryData([...scope(), 'detail', draft.id], draft);
      void client.invalidateQueries({ queryKey: [...scope(), 'list'] });
    },
  });
}

export function useArticlePreview() {
  return useMutation({
    mutationFn: ({ articleId, revision }: { articleId: string; revision: number }) =>
      previewArticleDraft(articleId, revision),
    networkMode: 'always',
    retry: false,
  });
}
