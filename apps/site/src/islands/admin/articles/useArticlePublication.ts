import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { articleReleaseActive } from '@vibelingan-channel/articles/release';
import { useEffect, useRef } from 'react';
import { getUser } from '../../../lib/session.ts';
import {
  getArticleRelease,
  getArticleReleaseCapability,
  writeArticleRelease,
} from './article-release-api.ts';

export function useArticlePublication(articleId: string | null) {
  const client = useQueryClient();
  const user = getUser()?.id;
  const key = ['article-publication', user, articleId] as const;
  const capability = useQuery({
    queryKey: ['article-publication', user, 'capability'],
    queryFn: ({ signal }) => getArticleReleaseCapability(signal),
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  const task = useQuery({
    queryKey: key,
    enabled: !!articleId && capability.data === true,
    queryFn: ({ signal }) => {
      if (!articleId) throw new Error('Article ID required');
      return getArticleRelease(articleId, signal);
    },
    refetchInterval: (query) =>
      query.state.data && articleReleaseActive(query.state.data.state) ? 2000 : false,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  const write = useMutation({
    mutationFn: writeArticleRelease,
    networkMode: 'always',
    retry: false,
    onSuccess: (result) => {
      client.setQueryData(['article-publication', user, result.articleId], result);
    },
  });
  const refreshed = useRef('');
  useEffect(() => {
    const value = task.data;
    if (!value || articleReleaseActive(value.state)) return;
    const revision = `${value.id}:${value.state}`;
    if (refreshed.current === revision) return;
    refreshed.current = revision;
    void client.invalidateQueries({ queryKey: ['article-drafts', user] });
  }, [task.data, client, user]);
  return { capability, task, write };
}
