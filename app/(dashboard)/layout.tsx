import { Sidebar } from '@/components/layout/Sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <div className="min-w-0 flex-1 overflow-y-auto scrollbar-thin">{children}</div>
      </div>
    </TooltipProvider>
  );
}
