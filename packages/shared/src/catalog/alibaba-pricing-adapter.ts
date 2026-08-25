export type AlibabaPricingDecision =
  | {
      source: 'alibaba';
      state: 'available';
      mode: 'fixed';
      currency: 'CNY' | 'USD';
      amountMinor: number;
      sourceMoq?: number;
    }
  | {
      source: 'alibaba';
      state: 'available';
      mode: 'range';
      currency: 'CNY' | 'USD';
      minAmountMinor: number;
      maxAmountMinor: number;
      sourceMoq?: number;
    }
  | {
      source: 'alibaba';
      state: 'available';
      mode: 'tiered';
      currency: 'CNY' | 'USD';
      tiers: Array<{ minQuantity: number; maxQuantity?: number; unitAmountMinor: number }>;
      sourceMoq?: number;
    }
  | {
      source: 'alibaba';
      state: 'quote';
      mode: 'negotiable';
      currency?: 'CNY' | 'USD';
      sourceMoq?: number;
    }
  | {
      source: 'alibaba';
      state: 'unavailable';
      mode: 'unavailable';
      sourceMoq?: number;
    };

export interface AlibabaPricingAdapter {
  resolve(link: unknown, provider: unknown): AlibabaPricingDecision;
}

export function createAlibabaPricingAdapter(): AlibabaPricingAdapter {
  return {
    resolve(_link: unknown, _provider: unknown): AlibabaPricingDecision {
      throw new Error('MIU 06 Alibaba pricing adapter not implemented');
    },
  };
}
