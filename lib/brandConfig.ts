export type BrandKey = "careu" | "ezy";

export type BranchConfig = {
  id: string;
  name: string;
  brand: BrandKey;
  shortName: string;
  receiptName: string;
  tagline: string;
  address: string;
  phone: string;
  logoPath: string;
  accentClass: string;
};

export const branches: BranchConfig[] = [
  {
    id: "c24-thonburi-market",
    name: "C24 Care U - ตลาดสดธนบุรี",
    brand: "careu",
    shortName: "C24 Care U",
    receiptName: "C24 Care U",
    tagline: "แคร์ยู ดูแลเสื้อผ้าคุณด้วยใจ",
    address: "ตลาดสดธนบุรี",
    phone: "N/A",
    logoPath: "/logos/c24-careu.svg",
    accentClass: "from-green-700 to-emerald-600",
  },
  {
    id: "ezy-repair-saladaeng",
    name: "Ezy Repair by Care U - BTS ศาลาแดง",
    brand: "ezy",
    shortName: "Ezy Repair",
    receiptName: "Ezy Repair by Care U",
    tagline: "ซ่อมไว ได้ดั่งใจ แค่ทักไลน์",
    address: "BTS ศาลาแดง",
    phone: "N/A",
    logoPath: "/logos/ezy-repair.svg",
    accentClass: "from-green-800 to-lime-700",
  },
];

export const defaultBranch = branches[0];

export function getBranchById(branchId?: string | null): BranchConfig {
  return branches.find((branch) => branch.id === branchId) ?? defaultBranch;
}
