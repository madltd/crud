import { Document } from 'mongoose';
import { Post } from './post.entity';

export type PostDocument = Post & Document;
