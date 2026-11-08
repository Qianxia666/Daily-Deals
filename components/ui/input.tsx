import * as React from 'react';
import { cn } from '@/lib/utils';

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        'h-11 w-full rounded-xl border border-line bg-white px-3 text-sm text-ink transition-colors placeholder:text-slate-500 hover:border-slate-300 focus:border-slate-400',
        className,
      )}
      {...props}
    />
  );
});
