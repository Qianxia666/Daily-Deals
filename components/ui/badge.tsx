import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium leading-5',
  {
    variants: {
      variant: {
        neutral: 'border-line bg-slate-50 text-slate-600',
        outline: 'border-line bg-white text-slate-600',
        gold: 'border-amber-200 bg-amber-50 text-amber-800',
        muted: 'border-transparent bg-slate-100 text-slate-600',
      },
    },
    defaultVariants: {
      variant: 'neutral',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}
