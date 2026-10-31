export type Role = 'student' | 'faculty' | 'admin'
export type AttendanceStatus = 'present' | 'flagged' | 'rejected' | 'pending_review'

export interface Profile { id: string; full_name: string; role: Role; identifier: string; email: string; department: string; avatar?: string; enrollment_photo_path?: string; must_change_password?: boolean; approval_status?: string }
export interface ClassItem { id: string; name: string; code: string; faculty: string; room: string; nextAt: string; enrolled: number; color: string; attendance: number }
export interface AttendanceRecord { id: string; className: string; code: string; date: string; time: string; status: AttendanceStatus; room: string; distance?: string; evidence?: boolean }
export interface Session { id: string; className: string; code: string; room: string; startedAt: string; endsAt: string; present: number; total: number; radius: number; qr: string }
