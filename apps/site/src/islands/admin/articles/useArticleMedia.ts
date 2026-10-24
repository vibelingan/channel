import { useMutation, useQuery } from '@tanstack/react-query';
import { ARTICLE_IMAGE_MAX_COUNT } from '@vibelingan-channel/articles/media';
import { useEffect, useState } from 'react';
import { getUser } from '../../../lib/session.ts';
import { getArticleImage, uploadArticleImage } from './article-media-api.ts';

export function useArticleImage(articleId: string | null, mediaId: string) {
  return useQuery({
    queryKey: ['article-media', getUser()?.id, articleId, mediaId],
    queryFn: ({ signal }) => {
      if (!articleId) throw new Error('Save the draft before using images.');
      return getArticleImage(articleId, mediaId, signal);
    },
    enabled: !!articleId && !!mediaId,
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}
export function useObjectUrl(blob: Blob | undefined) {
  const [state, setState] = useState<{ blob: Blob; url: string } | null>(null);
  useEffect(() => {
    if (!blob) {
      setState(null);
      return;
    }
    const url = URL.createObjectURL(blob);
    setState({ blob, url });
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  return state?.blob === blob ? state?.url : undefined;
}

export function useUploadArticleImage() {
  return useMutation({ mutationFn: uploadArticleImage, networkMode: 'always', retry: false });
}
export function useArticlePreviewImages(preview: {
  articleId: string;
  revision: number;
  mediaIds: string[];
}) {
  return useQuery({
    queryKey: ['article-preview-media', getUser()?.id, preview.articleId, preview.revision],
    queryFn: async ({ signal }) => {
      if (preview.mediaIds.length > ARTICLE_IMAGE_MAX_COUNT)
        throw new Error('Too many article images.');
      const result: Record<string, Awaited<ReturnType<typeof getArticleImage>>> = {};
      for (const id of preview.mediaIds)
        result[id] = await getArticleImage(preview.articleId, id, signal);
      return result;
    },
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });
}
