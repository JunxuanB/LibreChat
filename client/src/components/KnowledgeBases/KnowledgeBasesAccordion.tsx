import KnowledgeBasesSidePanel from './KnowledgeBasesSidePanel';

export default function KnowledgeBasesAccordion() {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <KnowledgeBasesSidePanel className="min-h-0 flex-1 border-r-0" />
    </div>
  );
}
