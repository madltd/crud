import { Document } from 'mongoose';

import { User } from './user.entity';

export type UserDocument = User & Document;
