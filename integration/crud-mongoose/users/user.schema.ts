import { Schema } from 'mongoose';
import { User } from './user.entity';

export const userSchema: Schema = new Schema<User>({
  name: String,
  email: String,
  password: String,
  title: String,
  age: Number
}, {
  // _id: false,
  timestamps: true
});

userSchema.virtual('posts', {
  ref: 'Post',
  localField: '_id',
  foreignField: 'userId',
  justOne: false,
});

userSchema.virtual('comments', {
  ref: 'Comment',
  localField: '_id',
  foreignField: 'userId',
  justOne: false,
});
