import { deliverStaticContent } from '../release/static-delivery.mjs';
import { BLOG_DUMMY_POLICY as policy } from './policy.mjs';

export function deliverBlogDummy(options) {
  return deliverStaticContent(options, { policy, scopeKey: 'canary' });
}
